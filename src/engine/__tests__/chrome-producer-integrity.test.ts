import {
  graphicsOperators, graphicsProbe, producerContracts, rawProducerPdf, rawStream,
  unusualOperators, unusualPrefix, type ProducerFixture,
} from './producer-integrity.helpers';

export function buildChromeFixture(): ProducerFixture {
  const texts = ['Invoice 731', 'Mira Voss | devis', 'Niko Vale | Αθήνα | Київ'];
  const replacement = 'Invoice 731 revised';
  const characters = [...new Set([...texts.join(''), ...replacement])];
  const codes = new Map(characters.map((char, index) => [char, index + 1]));
  const hexCode = (char: string) => codes.get(char)!.toString(16).padStart(4, '0');
  const shows = texts.map(text => `[${[...text].map((char, index) => {
    const hex = hexCode(char);
    return `<${hex.slice(0, 2)} ${hex.slice(2)}> ${index % 2 ? '-.5' : '12.3456'}`;
  }).join(' ')}] TJ`);
  const cmap = `/CIDInit /ProcSet findresource begin\r\n12 dict begin\r\nbegincmap\r\n/CIDSystemInfo << /Registry (Fictional) /Ordering (Invoice) /Supplement 0 >> def\r\n/CMapName /FictionalInvoice def\r\n/CMapType 2 def\r\n1 begincodespacerange\r\n<0000> <FFFF>\r\nendcodespacerange\r\n${characters.length} beginbfchar\r\n${characters.map(char => `<${hexCode(char)}> <${char.charCodeAt(0).toString(16).padStart(4, '0')}>`).join('\r\n')}\r\nendbfchar\r\nendcmap\r\nCMapName currentdict /CMap defineresource pop\r\nend\r\nend\r\n`;
  const rows = [
    'q', '.75 0 0 -.75 0 792 cm', '/GS1 gs',
    'q', '1 0 0 1 12 24 cm', 'BT', '/F1 16 Tf',
    '1 0 0 -1 40 60 Tm', shows[0],
    '1 0 0 -1 40 90 Tm', shows[1],
    '1 0 0 -1 40 120 Tm', shows[2], 'ET', 'Q',
  ];
  const content = unusualPrefix + rows.join('\r\n') + '\r\n' + graphicsProbe +
    'q\r\n8 0 0 8 460 160 cm\r\n/Im1 Do\r\nQ\r\nQ\r\n';
  const extras: Array<readonly [number, string]> = [
    [20, '<< /Type /Font /Subtype /Type0 /BaseFont /FictionalSkia /Encoding /Identity-H /DescendantFonts [21 0 R] /ToUnicode 23 0 R >>'],
    [21, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /FictionalSkia /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 22 0 R /DW 600 /CIDToGIDMap /Identity >>'],
    [22, '<< /Type /FontDescriptor /FontName /FictionalSkia /Flags 32 /FontBBox [0 -250 1000 750] /ItalicAngle 0 /Ascent 750 /Descent -250 /CapHeight 700 /StemV 80 >>'],
    [23, rawStream(cmap)],
    [24, '<< /Type /ExtGState /ca .5 /CA .75 >>'],
    [25, rawStream('ABC', '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 26 0 R')],
    [26, rawStream('Z', '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8')],
  ];
  return {
    name: 'Chrome/Skia Identity-H invoice', content,
    bytes: rawProducerPdf(content, '<< /Font << /F1 20 0 R >> /ExtGState << /GS1 24 0 R >> /XObject << /Im1 25 0 R >> >>', extras),
    targetIndex: 0, replacement,
    runs: texts.map((text, index) => ({ text, x: 39, y: 729 - index * 22.5, fontSize: 16 })),
    operators: [
      ...unusualOperators, 'q', 'cm', 'gs', 'q', 'cm', 'BT', 'Tf',
      'Tm', 'TJ', 'Tm', 'TJ', 'Tm', 'TJ', 'ET', 'Q',
      ...graphicsOperators, 'q', 'cm', 'Do', 'Q', 'Q',
    ],
  };
}

producerContracts(buildChromeFixture());
