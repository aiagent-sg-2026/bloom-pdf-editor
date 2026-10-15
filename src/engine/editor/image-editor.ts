import { PDFDict, PDFName, PDFNumber, PDFStream, PDFRef } from '../types';
import type { PDFDocumentData, PDFPageInfo, PDFObject } from '../types';
import type { ImageItem } from '../content/interpreter';
import { getResource, resolvePageResources, resolveRef } from '../parser/parser';
import { isolateBaseCtm } from './content-append';
import { flateEncode } from '../parser/filters';
import { getNextObjNum as nextObjectNumber } from '../writer/serializer';

export interface ImageRunOptions {
  rotationDegrees?: number;
  opacity?: number;
}

/** Build indirect Flate RGB + DeviceGray soft-mask image objects from RGBA pixels. */
export async function createRGBAImageObjects(
  rgba: Uint8Array,
  width: number,
  height: number,
  getNextObjNum: () => number,
): Promise<{ imageRef: PDFRef; image: PDFStream; smaskRef: PDFRef | null; smask: PDFStream | null }> {
  if (rgba.length !== width * height * 4) throw new Error('RGBA buffer size does not match image dimensions');
  const rgb = new Uint8Array(width * height * 3);
  const alpha = new Uint8Array(width * height);
  let hasAlpha = false;
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    rgb[p * 3] = rgba[i]; rgb[p * 3 + 1] = rgba[i + 1]; rgb[p * 3 + 2] = rgba[i + 2];
    alpha[p] = rgba[i + 3]; if (alpha[p] !== 255) hasAlpha = true;
  }
  const imageDict = new PDFDict();
  imageDict.set('Type', new PDFName('XObject')); imageDict.set('Subtype', new PDFName('Image'));
  imageDict.set('Width', new PDFNumber(width)); imageDict.set('Height', new PDFNumber(height));
  imageDict.set('ColorSpace', new PDFName('DeviceRGB')); imageDict.set('BitsPerComponent', new PDFNumber(8));
  imageDict.set('Filter', new PDFName('FlateDecode'));
  let smask: PDFStream | null = null;
  let smaskRef: PDFRef | null = null;
  if (hasAlpha) {
    const smaskDict = new PDFDict();
    smaskDict.set('Type', new PDFName('XObject')); smaskDict.set('Subtype', new PDFName('Image'));
    smaskDict.set('Width', new PDFNumber(width)); smaskDict.set('Height', new PDFNumber(height));
    smaskDict.set('ColorSpace', new PDFName('DeviceGray')); smaskDict.set('BitsPerComponent', new PDFNumber(8));
    smaskDict.set('Filter', new PDFName('FlateDecode'));
    const alphaBytes = await flateEncode(alpha);
    smaskDict.set('Length', new PDFNumber(alphaBytes.length));
    smask = new PDFStream(smaskDict, alphaBytes, alpha);
    smaskRef = new PDFRef(getNextObjNum(), 0);
    imageDict.set('SMask', smaskRef);
  }
  const rgbBytes = await flateEncode(rgb);
  imageDict.set('Length', new PDFNumber(rgbBytes.length));
  const image = new PDFStream(imageDict, rgbBytes, rgb);
  const imageRef = new PDFRef(getNextObjNum(), 0);
  return { imageRef, image, smaskRef, smask };
}

/**
 * Inserts an image into the PDF content stream by creating an Image XObject.
 * Note: imageDataUrl must be a JPEG Data URL (image/jpeg).
 */
export async function insertImageRun(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  imageDataUrl: string, // must be image/jpeg
  x: number,
  y: number,
  width: number,
  height: number,
  getNextObjNum: () => number,
  options?: ImageRunOptions,
): Promise<{ newContentBytes: Uint8Array }> {
  
  // 1. Convert Data URL to Uint8Array
  const base64Data = imageDataUrl.split(',')[1];
  const binaryString = atob(base64Data);
  const imageBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    imageBytes[i] = binaryString.charCodeAt(i);
  }

  // 2. Read image dimensions
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = imageDataUrl;
  });
  
  const trueWidth = img.naturalWidth;
  const trueHeight = img.naturalHeight;

  if (imageDataUrl.startsWith('data:image/png')) {
    const canvas = document.createElement('canvas'); canvas.width = trueWidth; canvas.height = trueHeight;
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(img, 0, 0);
    const rgba = ctx.getImageData(0, 0, trueWidth, trueHeight).data;
    const built = await createRGBAImageObjects(new Uint8Array(rgba), trueWidth, trueHeight, getNextObjNum);
    if (built.smaskRef && built.smask) objects.set(built.smaskRef.toKey(), built.smask);
    objects.set(built.imageRef.toKey(), built.image);
    return registerImageRun(page, objects, built.imageRef, x, y, width, height, contentBytes, options);
  }

  // 3. Create the Image XObject dictionary
  const dict = new PDFDict();
  dict.set('Type', new PDFName('XObject'));
  dict.set('Subtype', new PDFName('Image'));
  dict.set('Width', new PDFNumber(trueWidth));
  dict.set('Height', new PDFNumber(trueHeight));
  dict.set('ColorSpace', new PDFName('DeviceRGB'));
  dict.set('BitsPerComponent', new PDFNumber(8));
  dict.set('Filter', new PDFName('DCTDecode'));
  dict.set('Length', new PDFNumber(imageBytes.length));

  // 4. Create the stream object
  const imageStream = new PDFStream(dict, imageBytes);
  const objNum = getNextObjNum();
  const objRef = new PDFRef(objNum, 0);
  objects.set(objRef.toKey(), imageStream);

  return registerImageRun(page, objects, objRef, x, y, width, height, contentBytes, options);
}

function registerImageRun(page: PDFPageInfo, objects: Map<string, PDFObject>, objRef: PDFRef, x: number, y: number, width: number, height: number, contentBytes: Uint8Array, options?: ImageRunOptions): { newContentBytes: Uint8Array } {
  const resourcesObj = page.dict.get('Resources');
  let resources = resourcesObj === undefined ? undefined : resolveRef(resourcesObj, objects);
  if (!(resources instanceof PDFDict)) {
    const inherited = resourcesObj === undefined ? resolvePageResources(page.dict, objects) : new PDFDict();
    resources = new PDFDict();
    for (const [key, value] of inherited.entries()) {
      // Copy category dictionaries, including indirect ones, before adding entries.
      // Resource definitions remain shared; sibling category membership does not.
      const category = resolveRef(value, objects);
      if (category instanceof PDFDict) {
        const copy = new PDFDict();
        for (const [name, resource] of category.entries()) copy.set(name, resource);
        resources.set(key, copy);
      } else {
        resources.set(key, value);
      }
    }
    page.dict.set('Resources', resources);
  }
  page.resources = resources;
  const xobjectsObj = resources.get('XObject');
  let xobjects = xobjectsObj === undefined ? undefined : resolveRef(xobjectsObj, objects);
  if (!(xobjects instanceof PDFDict)) {
    xobjects = new PDFDict();
    resources.set('XObject', xobjects);
  }
  let imgName = 'Im1'; let i = 1; while (xobjects.has(imgName)) imgName = `Im${++i}`;
  xobjects.set(imgName, objRef);
  const injection = buildImageInjection(page, objects, imgName, x, y, width, height, options);
  const injectionBytes = new TextEncoder().encode(injection); const base = isolateBaseCtm(contentBytes);
  const newContentBytes = new Uint8Array(base.length + injectionBytes.length); newContentBytes.set(base); newContentBytes.set(injectionBytes, base.length);
  return { newContentBytes };
}

function buildImageInjection(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  imageName: string,
  x: number,
  y: number,
  width: number,
  height: number,
  options?: ImageRunOptions,
): string {
  const rotation = options?.rotationDegrees ?? 0;
  const opacity = options?.opacity ?? 1;
  let graphicsStateName: string | undefined;
  if (opacity < 1) {
    graphicsStateName = addImageOpacityGraphicsState(page, objects, opacity);
  }

  // The signature rotation is already a PDF-convention angle: positive values
  // rotate counter-clockwise, matching the CSS overlay's negative angle.
  let rotationCommands = '';
  if (rotation !== 0) {
    const angle = rotation * Math.PI / 180;
    rotationCommands = [
      `1 0 0 1 ${x + width / 2} ${y - height / 2} cm`,
      `${formatNumber(Math.cos(angle))} ${formatNumber(Math.sin(angle))} ${formatNumber(-Math.sin(angle))} ${formatNumber(Math.cos(angle))} 0 0 cm`,
      `1 0 0 1 ${-(x + width / 2)} ${-(y - height / 2)} cm`,
    ].join('\n') + '\n';
  }
  const opacityCommand = graphicsStateName ? `/${graphicsStateName} gs\n` : '';
  return `\nq\n${opacityCommand}${rotationCommands}${width} 0 0 ${height} ${x} ${y - height} cm\n/${imageName} Do\nQ\n`;
}

function addImageOpacityGraphicsState(page: PDFPageInfo, objects: Map<string, PDFObject>, opacity: number): string {
  const resourcesObj = page.dict.get('Resources');
  const resources = resourcesObj instanceof PDFRef ? objects.get(resourcesObj.toKey()) as PDFDict : resourcesObj as PDFDict;
  const resolvedResources = resources instanceof PDFDict ? resources : new PDFDict();
  if (resolvedResources !== resources) page.dict.set('Resources', resolvedResources);
  const extObj = resolvedResources.get('ExtGState');
  const ext = extObj instanceof PDFRef ? objects.get(extObj.toKey()) as PDFDict : extObj as PDFDict;
  const extGStates = ext instanceof PDFDict ? ext : new PDFDict();
  if (extGStates !== ext) resolvedResources.set('ExtGState', extGStates);
  let name = 'SigGS1';
  let i = 1;
  while (extGStates.has(name)) name = `SigGS${++i}`;
  const gs = new PDFDict();
  gs.set('Type', new PDFName('ExtGState'));
  gs.set('ca', new PDFNumber(Math.max(0, Math.min(1, opacity))));
  gs.set('CA', new PDFNumber(Math.max(0, Math.min(1, opacity))));
  extGStates.set(name, gs);
  return name;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(10)).toString();
}
/** Count resource entries per page/form scope, including shared resource dictionaries. */
function imageIsShared(doc: PDFDocumentData, image: PDFStream): boolean {
  let uses = 0;
  const forms = new Set<PDFStream>();
  const countResources = (resources: PDFDict): boolean => {
    const entry = resources.get('XObject');
    const xobjects = entry ? resolveRef(entry, doc.objects) : undefined;
    if (!(xobjects instanceof PDFDict)) return false;
    for (const value of xobjects.values()) {
      const object = resolveRef(value, doc.objects);
      if (object === image && ++uses > 1) return true;
      if (object instanceof PDFStream && object.dict.getName('Subtype') === 'Form') forms.add(object);
    }
    return false;
  };
  for (const page of doc.pages) {
    if (countResources(page.resources)) return true;
  }
  // Forms can hold image references even when absent from the edited page's resources.
  for (const object of doc.objects.values()) {
    if (object instanceof PDFStream && object.dict.getName('Subtype') === 'Form') forms.add(object);
  }
  for (const form of forms) {
    const entry = form.dict.get('Resources');
    const resources = entry ? resolveRef(entry, doc.objects) : undefined;
    if (resources instanceof PDFDict && countResources(resources)) return true;
  }
  return false;
}


/**
 * Replace an embedded image's pixel data while keeping the same placement
 * (cm / Do / bbox). Shared streams are replaced through page-local resource entries;
 * single-use streams keep their object identity and indirect reference.
 *
 * @param imageDataUrl JPEG or PNG data URL
 */
export async function replaceImageXObject(
  doc: PDFDocumentData,
  pageIndex: number,
  image: ImageItem,
  imageDataUrl: string,
  getNextObjNum?: () => number,
): Promise<void> {
  const page = doc.pages[pageIndex];
  const name = image.name.replace(/^\//, '');
  const xobj = getResource(page.resources, 'XObject', name, doc.objects);
  if (!(xobj instanceof PDFStream)) {
    throw new Error(`Image XObject /${name} not found`);
  }
  if (xobj.dict.getName('Subtype') !== 'Image') {
    throw new Error(`XObject /${name} is not an Image`);
  }

  const base64Data = imageDataUrl.split(',')[1];
  if (!base64Data) throw new Error('Invalid image data URL');
  const binaryString = atob(base64Data);
  const imageBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    imageBytes[i] = binaryString.charCodeAt(i);
  }

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to decode replacement image'));
    img.src = imageDataUrl;
  });

  const trueWidth = img.naturalWidth;
  const trueHeight = img.naturalHeight;

  // Reserve numbers locally: callers may compute max(objects) without reserving objects.
  let nextObjNum = nextObjectNumber(doc);
  const allocate = (): number => {
    const objNum = Math.max(nextObjNum, getNextObjNum?.() ?? nextObjNum);
    nextObjNum = objNum + 1;
    return objNum;
  };
  let replacement: PDFStream;
  let replacementRef: PDFRef | undefined;
  if (imageDataUrl.startsWith('data:image/png')) {
    const canvas = document.createElement('canvas'); canvas.width = trueWidth; canvas.height = trueHeight;
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(img, 0, 0);
    const built = await createRGBAImageObjects(new Uint8Array(ctx.getImageData(0, 0, trueWidth, trueHeight).data), trueWidth, trueHeight, allocate);
    if (built.smaskRef && built.smask) doc.objects.set(built.smaskRef.toKey(), built.smask);
    replacement = built.image;
    replacementRef = built.imageRef;
  } else {
    const dict = new PDFDict();
    dict.set('Type', new PDFName('XObject'));
    dict.set('Subtype', new PDFName('Image'));
    dict.set('Width', new PDFNumber(trueWidth));
    dict.set('Height', new PDFNumber(trueHeight));
    dict.set('ColorSpace', new PDFName('DeviceRGB'));
    dict.set('BitsPerComponent', new PDFNumber(8));
    dict.set('Filter', new PDFName('DCTDecode'));
    dict.set('Length', new PDFNumber(imageBytes.length));
    replacement = new PDFStream(dict, imageBytes);
  }

  if (imageIsShared(doc, xobj)) {
    const ref = replacementRef ?? new PDFRef(allocate(), 0);
    const resources = new PDFDict([...page.resources.entries()]);
    const entry = resources.get('XObject');
    const previous = entry ? resolveRef(entry, doc.objects) : undefined;
    const xobjects = new PDFDict(previous instanceof PDFDict ? [...previous.entries()] : []);
    xobjects.set(name, ref);
    resources.set('XObject', xobjects);
    doc.objects.set(ref.toKey(), replacement);
    page.dict.set('Resources', resources);
    page.resources = resources;
    return;
  }

  // Rebuild from the new encoding's keys; no old masks, Decode, or external filters survive.
  for (const key of xobj.dict.keys()) xobj.dict.delete(key);
  for (const [key, value] of replacement.dict.entries()) xobj.dict.set(key, value);
  xobj.rawBytes = replacement.rawBytes;
  xobj.decodedBytes = replacement.decodedBytes;
}
