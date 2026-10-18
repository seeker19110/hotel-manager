declare const html: string;
declare const node: HTMLElement;

export function Bad() {
  // ruleid: hm-xss-html-sink
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Bad2() {
  // ruleid: hm-xss-html-sink
  node.innerHTML = html;
  // ruleid: hm-xss-html-sink
  node.insertAdjacentHTML("beforeend", html);
  // ruleid: hm-xss-html-sink
  document.write(html);
}

export function Good() {
  // ok: hm-xss-html-sink
  node.textContent = html;
  // ok: hm-xss-html-sink
  return <div>{html}</div>;
}
