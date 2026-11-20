export interface ActivityPdfData {
  rows: Record<string, string>[];
  babyName: string;
  filename: string;
  title: string;
  range: string;
  timezone: string;
  language: string;
}

function element(tag: string, className: string, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/** Render text through the browser, like the existing monthly PDF, so localized
 * labels and caregiver text use the same font shaping as the app. Each canvas
 * is one page; a long history never becomes a browser-sized giant canvas. */
export async function downloadActivityPdf(data: ActivityPdfData) {
  const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
    import('html2canvas-pro'), import('jspdf'),
  ]);
  const root = element('div', 'full-log-pdf-root');
  root.setAttribute('aria-hidden', 'true');
  root.inert = true;
  document.body.append(root);
  try {
    await document.fonts.ready;
    const pages: HTMLElement[] = [], footers: HTMLElement[] = [];
    let content: HTMLElement;
    const number = new Intl.NumberFormat(data.language);
    function addPage() {
      const page = element('section', 'full-log-pdf-page');
      const header = element('header', 'full-log-pdf-header');
      header.append(element('h1', 'full-log-pdf-title', data.title),
        element('p', 'full-log-pdf-child', data.babyName),
        element('p', 'full-log-pdf-range', `${data.range} · ${data.timezone}`));
      content = element('div', 'full-log-pdf-content');
      const footer = element('footer', 'full-log-pdf-footer');
      page.append(header, content, footer); root.append(page);
      pages.push(page); footers.push(footer);
    }
    const fits = () => content.scrollHeight <= content.clientHeight;
    addPage();

    function appendText(text: string, heading = false) {
      // Grapheme boundaries keep surrogate pairs and combining marks together.
      const segments = [...new Intl.Segmenter(data.language, { granularity: 'grapheme' }).segment(text)].map(part => part.segment);
      let remaining = segments;
      while (remaining.length) {
        const block = element(heading ? 'h2' : 'p', heading ? 'full-log-pdf-entry' : 'full-log-pdf-field');
        content.append(block);
        block.textContent = remaining.join('');
        if (fits()) return;
        // Fit the largest intact prefix. No field or overflowing tail is omitted.
        let low = 0, high = remaining.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          block.textContent = remaining.slice(0, middle).join('');
          if (fits()) low = middle; else high = middle - 1;
        }
        if (low === 0) {
          block.remove();
          if (!content.children.length) throw new Error('PDF page cannot fit text');
          addPage(); continue;
        }
        // Prefer an existing whitespace boundary when one is nearby, while
        // retaining every original character for the following page.
        let boundary = low;
        for (let index = low - 1; index >= Math.max(1, low - 60); index--) {
          if (/\s/u.test(remaining[index])) { boundary = index + 1; break; }
        }
        block.textContent = remaining.slice(0, boundary).join('');
        remaining = remaining.slice(boundary);
        addPage();
      }
    }

    data.rows.forEach((row, index) => {
      // Keep the entry heading with room for at least the first field.
      const last = content.lastElementChild;
      const usedHeight = last ? last.getBoundingClientRect().bottom - content.getBoundingClientRect().top + 8 : 0;
      if (last && content.clientHeight - usedHeight < 80) addPage();
      appendText(`${data.title} ${number.format(index + 1)}`, true);
      for (const [label, value] of Object.entries(row)) {
        if (value !== '') appendText(`${label}: ${value}`);
      }
    });
    footers.forEach((footer, index) => { footer.textContent = `${number.format(index + 1)} / ${number.format(pages.length)}`; });

    const pdf = new jsPDF('p', 'mm', 'letter');
    for (const [index, page] of pages.entries()) {
      const canvas = await html2canvas(page, { scale: 2, backgroundColor: '#ffffff', logging: false, scrollX: 0, scrollY: 0 });
      if (index) pdf.addPage();
      pdf.addImage(canvas, 'PNG', 12.7, 12.7, 190.5, 254);
      // Release the canvas before drawing the next page.
      canvas.width = 0; canvas.height = 0;
    }
    await pdf.save(data.filename, { returnPromise: true });
  } finally { root.remove(); }
}
