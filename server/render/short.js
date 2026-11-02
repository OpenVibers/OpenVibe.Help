'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): one or two screens, app-like.
 *
 *   foldBlock()  a part a reader rarely needs, closed on a phone and open where there is room. The page's own markup
 *                keeps it open, so a browser without the script shows it as before; the script closes it on a narrow
 *                screen and remembers the reader's choice.
 *
 * The CSS for the fold lives in this site's own stylesheet. The old pick block (a chip row plus the picked card) was
 * removed on 2026-10-31: the home's site list is one list of links, so the chips and the card read as the same list
 * twice on a phone.
 */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * What a fold holds, counted, for its title row (the owner, 2026-10-31: a fold that shortens a page shows its count):
 * "6 questions", "12 items", "latest 5" for the shipped list, or nothing when there is nothing to count. Replaces the
 * hint the fold used to show instead.
 */
function foldMeta(body, cls = '') {
    const s = typeof body === 'string' ? body : String((body && (body.s || body.html || body.value)) || body || '');
    const n = (re) => (s.match(re) || []).length;
    const shipped = /data-ov-shipped="list"[^>]*?data-limit="(\d+)"|data-limit="(\d+)"[^>]*?data-ov-shipped="list"/.exec(s);
    const q = n(/<details[\s>]/g), li = n(/<li[\s>]/g), a = n(/<a\s/g);
    const text = shipped ? `latest ${shipped[1] || shipped[2]}` : q > 1 ? `${q} questions` : li > 1 ? `${li} items` : a > 1 ? `${a} links` : '';
    return text ? `<span${cls ? ` class="${cls}"` : ''}>${text}</span>` : '';
}

/**
 * A fold. The head is the heading the block had; the html is what it holds.
 *
 *   foldBlock({ id, head, html })
 */
function foldBlock({ id, head, html }) {
    return '<details class="hp-fold hp-fold-block" id="' + esc(id) + '" open><summary>' + head + foldMeta(html, 'hp-fold-hint') + '</summary>' + html + '</details>' + foldScript(id);
}

/** The script a fold carries: closed on a phone unless the reader opened it before, and it remembers that. */
function foldScript(id) {
    return "<script>(function(){var d=document.getElementById(" + JSON.stringify(id) + ");if(!d)return;var k='ov_fold_'+" + JSON.stringify(id) + ";var s=null;try{s=localStorage.getItem(k)}catch(e){}if(s==='open'){d.open=true;return}if(s==='closed'){d.open=false;return}var t=0;if(window.matchMedia&&window.matchMedia('(max-width:640px)').matches){t=Date.now();d.open=false}d.addEventListener('toggle',function(){if(Date.now()-t<300)return;try{localStorage.setItem(k,d.open?'open':'closed')}catch(e){}})})();</script>";
}

/**
 * A part of a page's own markup, found by the heading it carries: the site can then show it as a fold. { start, end,
 * html } — the section that holds the needle.
 */
function part(html, needle) {
    const at = html.indexOf(needle);
    if (at < 0) return null;
    const start = html.lastIndexOf('<section', at);
    const close = html.indexOf('</section>', at);
    if (start < 0 || close < 0) return null;
    const end = close + '</section>'.length;
    return { start, end, html: html.slice(start, end) };
}

/** The same part, but replaced by something else. */
function swap(html, needle, withHtml) {
    const p = part(html, needle);
    if (!p) return html;
    return html.slice(0, p.start) + withHtml + html.slice(p.end);
}

/** The part that carries this heading, as a fold: closed on a phone, the section it was where there is room. */
function foldAround(html, needle, id, head) {
    const p = part(html, needle);
    if (!p) return html;
    return html.slice(0, p.start) + foldBlock({ id, head, html: p.html }) + html.slice(p.end);
}

module.exports = { foldBlock, foldMeta, foldScript, part, swap, foldAround };
