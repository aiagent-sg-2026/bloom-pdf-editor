import {
  graphicsOperators, graphicsProbe, producerContracts, rawProducerPdf,
  unusualOperators, unusualPrefix, type ProducerFixture,
} from './producer-integrity.helpers';

export function buildLibreOfficeFixture(): ProducerFixture {
  const rows = [
    'q', '.5 w', '2 J', '1 j', '[3 .5 1.2345] -.5 d',
    'BT', '/F1 12 Tf', '18 TL', '40 700 Td',
    '[(Mira) -10000] TJ',
    // The next cell intentionally continues the text matrix without a move.
    // Courier advances 4 * .6 * 12 = 28.8, then the TJ gap adds 120.
    '[(Vale)] TJ',
    '80 -18 Td', '[(devis \\351)] TJ',
    '-80 -18 TD', '[(Niko \\(Frost\\))] TJ',
    'T*', '[<54 6F 74 61 6C> -.5 ( 42.50)] TJ',
    // LibreOffice-style tolerant stream: graphics q occurs before text ET.
    'q', '.4 g', '40 610 360 1 re f', '40 630 1 70 re f', 'Q', 'ET',
  ];
  const content = unusualPrefix + rows.join('\r\n') + '\r\n' + graphicsProbe + 'Q\r\n';
  return {
    name: 'LibreOffice relative-position table', content,
    bytes: rawProducerPdf(content, '<< /Font << /F1 20 0 R >> >>', [
      [20, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'],
    ]),
    targetIndex: 0, replacement: 'Mira Frost of fictional North Harbor',
    runs: [
      { text: 'Mira', x: 40, y: 700, fontSize: 12 },
      { text: 'Vale', x: 188.8, y: 700, fontSize: 12 },
      { text: 'devis é', x: 120, y: 682, fontSize: 12 },
      { text: 'Niko (Frost)', x: 40, y: 664, fontSize: 12 },
      { text: 'Total 42.50', x: 40, y: 646, fontSize: 12 },
    ],
    operators: [
      ...unusualOperators, 'q', 'w', 'J', 'j', 'd', 'BT', 'Tf', 'TL', 'Td',
      'TJ', 'TJ', 'Td', 'TJ', 'TD', 'TJ', 'T*', 'TJ',
      'q', 'g', 're', 'f', 're', 'f', 'Q', 'ET', ...graphicsOperators, 'Q',
    ],
  };
}

producerContracts(buildLibreOfficeFixture());
