import { PDFDict, PDFName, PDFNumber, PDFStream, PDFRef } from '../types';
import type { PDFDocumentData, PDFPageInfo, PDFObject } from '../types';
import type { ImageItem } from '../content/interpreter';
import { getResource } from '../parser/parser';
import { isolateBaseCtm } from './content-append';

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
