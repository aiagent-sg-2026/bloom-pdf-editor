import { PDFDict, PDFName, PDFNumber, PDFStream, PDFRef } from '../types';
import type { PDFDocumentData, PDFPageInfo, PDFObject } from '../types';
import type { ImageItem } from '../content/interpreter';
import { getResource } from '../parser/parser';
import { isolateBaseCtm } from './content-append';
import { flateEncode } from '../parser/filters';

/** Build indirect Flate RGB + DeviceGray soft-mask image objects from RGBA pixels. */
export async function createRGBAImageObjects(
  rgba: Uint8Array,
  width: number,
  height: number,
  getNextObjNum: () => number,
): Promise<{ imageRef: PDFRef; image: PDFStream; smaskRef: PDFRef; smask: PDFStream }> {
  if (rgba.length !== width * height * 4) throw new Error('RGBA buffer size does not match image dimensions');
  const rgb = new Uint8Array(width * height * 3);
  const alpha = new Uint8Array(width * height);
  let hasAlpha = false;
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    rgb[p * 3] = rgba[i]; rgb[p * 3 + 1] = rgba[i + 1]; rgb[p * 3 + 2] = rgba[i + 2];
    alpha[p] = rgba[i + 3]; if (alpha[p] !== 255) hasAlpha = true;
  }
  if (!hasAlpha) throw new Error('RGBA image has no transparency');
  const imageDict = new PDFDict();
  imageDict.set('Type', new PDFName('XObject')); imageDict.set('Subtype', new PDFName('Image'));
  imageDict.set('Width', new PDFNumber(width)); imageDict.set('Height', new PDFNumber(height));
  imageDict.set('ColorSpace', new PDFName('DeviceRGB')); imageDict.set('BitsPerComponent', new PDFNumber(8));
  imageDict.set('Filter', new PDFName('FlateDecode'));
  const smaskDict = new PDFDict();
  smaskDict.set('Type', new PDFName('XObject')); smaskDict.set('Subtype', new PDFName('Image'));
  smaskDict.set('Width', new PDFNumber(width)); smaskDict.set('Height', new PDFNumber(height));
  smaskDict.set('ColorSpace', new PDFName('DeviceGray')); smaskDict.set('BitsPerComponent', new PDFNumber(8));
  smaskDict.set('Filter', new PDFName('FlateDecode'));
  const smask = new PDFStream(smaskDict, await flateEncode(alpha));
  const smaskRef = new PDFRef(getNextObjNum(), 0);
  imageDict.set('SMask', smaskRef);
  const image = new PDFStream(imageDict, await flateEncode(rgb));
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
  getNextObjNum: () => number
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
    objects.set(built.smaskRef.toKey(), built.smask); objects.set(built.imageRef.toKey(), built.image);
    return registerImageRun(page, objects, built.imageRef, x, y, width, height, contentBytes);
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

  // 5. Register in page Resources
  const resourcesObj = page.dict.get('Resources');
  let resources = resourcesObj instanceof PDFRef ? (objects.get(resourcesObj.toKey()) as PDFDict) : resourcesObj as PDFDict;
  if (!resources || !(resources instanceof PDFDict)) {
    resources = new PDFDict();
    page.dict.set('Resources', resources);
  }
  
  let xobjects = resources.get('XObject');
  if (xobjects instanceof PDFRef) xobjects = objects.get(xobjects.toKey()) as PDFDict;
  if (!xobjects || !(xobjects instanceof PDFDict)) {
    xobjects = new PDFDict();
    resources.set('XObject', xobjects);
  }
  
  // Find a unique name
  let imgName = 'Im1';
  let i = 1;
  while (xobjects.has(imgName)) {
    i++;
    imgName = `Im${i}`;
  }
  xobjects.set(imgName, objRef);

  // 6. Inject the 'Do' command into the content stream
  const bottomY = y - height;
  
  const injection = `\nq\n${width} 0 0 ${height} ${x} ${bottomY} cm\n/${imgName} Do\nQ\n`;
  const enc = new TextEncoder();
  const injectionBytes = enc.encode(injection);

  const base = isolateBaseCtm(contentBytes);
  const newContentBytes = new Uint8Array(base.length + injectionBytes.length);
  newContentBytes.set(base);
  newContentBytes.set(injectionBytes, base.length);

  return { newContentBytes };
}

function registerImageRun(page: PDFPageInfo, objects: Map<string, PDFObject>, objRef: PDFRef, x: number, y: number, width: number, height: number, contentBytes: Uint8Array): { newContentBytes: Uint8Array } {
  const resourcesObj = page.dict.get('Resources');
  let resources = resourcesObj instanceof PDFRef ? objects.get(resourcesObj.toKey()) as PDFDict : resourcesObj as PDFDict;
  if (!(resources instanceof PDFDict)) { resources = new PDFDict(); page.dict.set('Resources', resources); }
  let xobjects = resources.get('XObject'); if (xobjects instanceof PDFRef) xobjects = objects.get(xobjects.toKey()) as PDFDict;
  if (!(xobjects instanceof PDFDict)) { xobjects = new PDFDict(); resources.set('XObject', xobjects); }
  let imgName = 'Im1'; let i = 1; while (xobjects.has(imgName)) imgName = `Im${++i}`;
  xobjects.set(imgName, objRef);
  const injection = `\nq\n${width} 0 0 ${height} ${x} ${y - height} cm\n/${imgName} Do\nQ\n`;
  const injectionBytes = new TextEncoder().encode(injection); const base = isolateBaseCtm(contentBytes);
  const newContentBytes = new Uint8Array(base.length + injectionBytes.length); newContentBytes.set(base); newContentBytes.set(injectionBytes, base.length);
  return { newContentBytes };
}

/**
 * Replace an embedded image's pixel data while keeping the same placement
 * (cm / Do / bbox). The content stream is untouched — only the XObject stream
 * and Width/Height dictionary entries are updated.
 *
 * @param imageDataUrl must be image/jpeg
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

  if (imageDataUrl.startsWith('data:image/png') && getNextObjNum) {
    const canvas = document.createElement('canvas'); canvas.width = trueWidth; canvas.height = trueHeight;
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(img, 0, 0);
    const built = await createRGBAImageObjects(new Uint8Array(ctx.getImageData(0, 0, trueWidth, trueHeight).data), trueWidth, trueHeight, getNextObjNum);
    doc.objects.set(built.smaskRef.toKey(), built.smask);
    xobj.rawBytes = built.image.rawBytes;
    xobj.decodedBytes = null;
    for (const [key, value] of built.image.dict.entries()) xobj.dict.set(key, value);
    return;
  }

  xobj.dict.set('Width', new PDFNumber(trueWidth));
  xobj.dict.set('Height', new PDFNumber(trueHeight));
  xobj.dict.set('ColorSpace', new PDFName('DeviceRGB'));
  xobj.dict.set('BitsPerComponent', new PDFNumber(8));
  xobj.dict.set('Filter', new PDFName('DCTDecode'));
  xobj.dict.set('Length', new PDFNumber(imageBytes.length));
  // Drop filters that don't apply to the new JPEG bytes
  xobj.dict.delete('DecodeParms');
  xobj.dict.delete('SMask');

  xobj.rawBytes = imageBytes;
  xobj.decodedBytes = null;
}
