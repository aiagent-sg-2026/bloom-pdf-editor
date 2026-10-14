import {
  graphicsOperators, graphicsProbe, producerContracts, rawProducerPdf,
  unusualOperators, unusualPrefix, type ProducerFixture,
} from './producer-integrity.helpers';

export function buildWordFixture(): ProducerFixture {
  const rows = [
    'q', '/P <</MCID 0>> BDC',
    'BT /F1 12 Tf .5 Tc -.5 Tw 95 Tz 1 0 0 1 40 720 Tm [(Quotation)]TJ ET',
    'BT /F1 12 Tf 1 0 0 1 220 720 Tm [(Q-731)]TJ ET', 'EMC',
    '/P << /MCID 1 >> BDC',
    'BT /F1 12 Tf 1 0 0 1 40 700 Tm [(Mira \\(Voss\\) \\101)]TJ ET',
    'BT /F1 12 Tf 1 0 0 1 220 700 Tm [(devis)]TJ ET',
    'BT /F1 12 Tf 1 0 0 1 340 700 Tm [<4E 69 6B 6F>]TJ ET', 'EMC',
    '/P <</MCID 2>> BDC',
    'BT /F1 12 Tf 3 Tr 1 0 0 1 40 680 Tm [(Search copy 731)]TJ ET',
    'BT /F1 12 Tf 0 Tr 1 0 0 1 40.1234 660.4321 Tm [(Total 42.50)]TJ ET', 'EMC',
    '/Artifact <</Type /Pagination>> BDC',
    'BT /F1 12 Tf 1 0 0 1 40 40 Tm [(Fictional quotation footer)]TJ ET', 'EMC',
    '% Producer comments are not text or operators',
  ];
  const content = unusualPrefix + rows.join('\r\n') + '\r\n' + graphicsProbe + 'Q\r\n';
  // Fictional, unembedded simple TrueType face with explicit uniform metrics.
  // No installed or real document font is used by this parser/editing fixture.
  const widths = Array.from({ length: 224 }, () => '600').join(' ');
  const extras: Array<readonly [number, string]> = [
    [20, `<< /Type /Font /Subtype /TrueType /BaseFont /FictionalWordSans /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 255 /Widths [${widths}] /FontDescriptor 21 0 R >>`],
    [21, '<< /Type /FontDescriptor /FontName /FictionalWordSans /Flags 32 /FontBBox [0 -200 1000 800] /Ascent 800 /Descent -200 /CapHeight 700 /ItalicAngle 0 /StemV 80 /MissingWidth 600 >>'],
  ];
  return {
    name: 'Word marked-content quotation', content,
    bytes: rawProducerPdf(content, '<< /Font << /F1 20 0 R >> >>', extras),
    targetIndex: 0, replacement: 'Quotation revised',
    runs: [
      { text: 'Quotation', x: 40, y: 720, fontSize: 12 },
      { text: 'Q-731', x: 220, y: 720, fontSize: 12 },
      { text: 'Mira (Voss) A', x: 40, y: 700, fontSize: 12 },
      { text: 'devis', x: 220, y: 700, fontSize: 12 },
      { text: 'Niko', x: 340, y: 700, fontSize: 12 },
      { text: 'Search copy 731', x: 40, y: 680, fontSize: 12 },
      { text: 'Total 42.50', x: 40.1234, y: 660.4321, fontSize: 12 },
      { text: 'Fictional quotation footer', x: 40, y: 40, fontSize: 12 },
    ],
    operators: [
      ...unusualOperators, 'q', 'BDC',
      'BT', 'Tf', 'Tc', 'Tw', 'Tz', 'Tm', 'TJ', 'ET',
      'BT', 'Tf', 'Tm', 'TJ', 'ET', 'EMC', 'BDC',
      'BT', 'Tf', 'Tm', 'TJ', 'ET', 'BT', 'Tf', 'Tm', 'TJ', 'ET',
      'BT', 'Tf', 'Tm', 'TJ', 'ET', 'EMC', 'BDC',
      'BT', 'Tf', 'Tr', 'Tm', 'TJ', 'ET', 'BT', 'Tf', 'Tr', 'Tm', 'TJ', 'ET',
      'EMC', 'BDC', 'BT', 'Tf', 'Tm', 'TJ', 'ET', 'EMC',
      ...graphicsOperators, 'Q',
    ],
  };
}

producerContracts(buildWordFixture());
