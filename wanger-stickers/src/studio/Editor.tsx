// The static sticker editor. Background tab: the photo with its mask (erase / restore brush, zoom,
// pan, automatic removal). Other tabs: the live sticker preview (shape, outline, shadow,
// adjustments, text layers you can drag). Every change goes through History (undo / redo).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StickerDoc, Shape } from '../engine/render';
import { renderSticker } from '../engine/render';
import { removeBackground, type ModelKind } from '../engine/segment';
import { History } from '../engine/history';
import { Mask } from '../engine/mask';
import { FONTS, loadFont, textBox, type FontKey, type TextLayer } from '../engine/text';
import { ctx2d } from '../engine/image';
import type { makeT } from './i18n';

type T = ReturnType<typeof makeT>;
type Tab = 'bg' | 'shape' | 'look' | 'text';
type Tool = 'erase' | 'restore' | 'move';

const VIEW = 320; // css px of the square view (scaled by devicePixelRatio)

export default function Editor({ doc, t, onNext, autoRemove }: { doc: StickerDoc; t: T; onNext: () => void; autoRemove?: boolean }) {
  const [tab, setTab] = useState<Tab>('bg');
  const [tool, setTool] = useState<Tool>('erase');
  const [brush, setBrush] = useState(28);
  const [soft, setSoft] = useState(0.4);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((n) => n + 1), []);
  const history = useMemo(() => new History(60), []);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{ x: number; y: number; id?: string; ox?: number; oy?: number } | null>(null);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = Math.round(VIEW * dpr);

  const change = (fn: () => void) => {
    history.push(doc);
    fn();
    rerender();
  };

  /* ---------------- drawing ---------------- */
  const bgGeom = () => {
    const base = Math.min(size / doc.src.width, size / doc.src.height);
    const k = base * zoom;
    return { k, ox: (size - doc.src.width * k) / 2 + pan.x * dpr, oy: (size - doc.src.height * k) / 2 + pan.y * dpr };
  };

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const id = requestAnimationFrame(() => {
      const x = ctx2d(c);
      x.clearRect(0, 0, size, size);
      if (tab === 'bg') {
        const { k, ox, oy } = bgGeom();
        const tmp = document.createElement('canvas');
        tmp.width = doc.src.width;
        tmp.height = doc.src.height;
        const tx = tmp.getContext('2d')!;
        tx.drawImage(doc.src as CanvasImageSource, 0, 0);
        tx.globalCompositeOperation = 'destination-in';
        tx.drawImage(doc.mask.toCanvas() as CanvasImageSource, 0, 0);
        // the removed part shown faintly, so the brush has something to restore
        x.globalAlpha = 0.18;
        x.drawImage(doc.src as CanvasImageSource, ox, oy, doc.src.width * k, doc.src.height * k);
        x.globalAlpha = 1;
        x.drawImage(tmp, ox, oy, doc.src.width * k, doc.src.height * k);
      } else {
        const r = renderSticker(doc, size);
        if (!r) {
          setNote(t('empty'));
          return;
        }
        setNote(null);
        x.drawImage(r.canvas as CanvasImageSource, (size - r.width) / 2, (size - r.height) / 2);
        if (tab === 'text' && sel) {
          const layer = doc.texts.find((l) => l.id === sel);
          if (layer) {
            const b = textBox(x, layer, r.width, r.height, size / 512);
            x.strokeStyle = 'rgba(42,125,225,0.9)';
            x.setLineDash([6, 4]);
            x.lineWidth = 2;
            x.strokeRect((size - r.width) / 2 + b.cx - b.w / 2 - 6, (size - r.height) / 2 + b.cy - b.h / 2 - 4, b.w + 12, b.h + 8);
            x.setLineDash([]);
          }
        }
      }
    });
    return () => cancelAnimationFrame(id);
  });

  /* ---------------- automatic removal ---------------- */
  const runAuto = useCallback(async (kind: ModelKind) => {
    setBusy(t('bg_model', { p: 0 }));
    try {
      const m = await removeBackground(doc.src, kind, (p) => setBusy(p < 1 ? t('bg_model', { p: Math.round(p * 100) }) : t('bg_working')));
      history.push(doc);
      doc.mask.set(m.data);
      setNote(null);
    } catch {
      setNote(t('bg_failed'));
    } finally {
      setBusy(null);
      rerender();
    }
  }, [doc, history, rerender, t]);

  useEffect(() => {
    if (autoRemove) void runAuto('general');
  }, [autoRemove, runAuto]);

  /* ---------------- pointer ---------------- */
  const point = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * size, y: ((e.clientY - r.top) / r.height) * size };
  };

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = point(e);
    if (tab === 'bg') {
      if (tool === 'move') drag.current = { x: p.x, y: p.y, ox: pan.x, oy: pan.y };
      else {
        history.push(doc);
        drag.current = { x: p.x, y: p.y };
        paint(p, p);
      }
    } else if (tab === 'text') {
      const r = renderSticker(doc, size);
      if (!r) return;
      const x = ctx2d(canvasRef.current!);
      const offX = (size - r.width) / 2;
      const offY = (size - r.height) / 2;
      const hit = [...doc.texts].reverse().find((l) => {
        const b = textBox(x, l, r.width, r.height, size / 512);
        return Math.abs(p.x - offX - b.cx) <= b.w / 2 + 10 && Math.abs(p.y - offY - b.cy) <= b.h / 2 + 10;
      });
      if (hit) {
        history.push(doc);
        setSel(hit.id);
        drag.current = { x: p.x, y: p.y, id: hit.id, ox: hit.x, oy: hit.y };
      }
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    if (tab === 'bg' && tool === 'move') {
      setPan({ x: (d.ox ?? 0) + (p.x - d.x) / dpr, y: (d.oy ?? 0) + (p.y - d.y) / dpr });
    } else if (tab === 'bg') {
      paint({ x: d.x, y: d.y }, p);
      drag.current = { x: p.x, y: p.y };
    } else if (tab === 'text' && d.id) {
      const r = renderSticker(doc, size);
      const layer = doc.texts.find((l) => l.id === d.id);
      if (!r || !layer) return;
      layer.x = Math.min(1, Math.max(0, (d.ox ?? 0.5) + (p.x - d.x) / r.width));
      layer.y = Math.min(1, Math.max(0, (d.oy ?? 0.5) + (p.y - d.y) / r.height));
      rerender();
    }
  };

  const onUp = () => {
    drag.current = null;
  };

  function paint(a: { x: number; y: number }, b: { x: number; y: number }) {
    const { k, ox, oy } = bgGeom();
    const r = (brush * dpr) / k;
    doc.mask.stroke((a.x - ox) / k, (a.y - oy) / k, (b.x - ox) / k, (b.y - oy) / k, r, soft, tool === 'erase' ? 'erase' : 'restore');
    rerender();
  }

  /* ---------------- text ---------------- */
  const selected = doc.texts.find((l) => l.id === sel) || null;
  const addText = async () => {
    await loadFont('vazirmatn');
    const layer: TextLayer = { id: Math.random().toString(36).slice(2, 9), text: t('text_placeholder').replace('…', ''), font: 'vazirmatn', size: 56, color: '#ffffff', stroke: '#111111', strokeWidth: 5, shadow: true, x: 0.5, y: 0.85, rotation: 0 };
    change(() => doc.texts.push(layer));
    setSel(layer.id);
  };
  const editText = (patch: Partial<TextLayer>) => {
    if (!selected) return;
    if (patch.font) void loadFont(patch.font).then(rerender);
    Object.assign(selected, patch);
    rerender();
  };

  /* ---------------- UI ---------------- */
  const shapes: Shape[] = ['free', 'square', 'circle', 'rounded'];
  return (
    <div className="editor">
      <div className="view checker">
        <canvas
          ref={canvasRef}
          width={size}
          height={size}
          style={{ width: VIEW, height: VIEW, touchAction: 'none' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        {busy && <div className="busy">{busy}</div>}
      </div>
      {note && <p className="note">{note}</p>}

      <div className="row undo">
        <button disabled={!history.canUndo} onClick={() => { history.undo(doc); rerender(); }} aria-label="undo">{t('undo')}</button>
        <button disabled={!history.canRedo} onClick={() => { history.redo(doc); rerender(); }} aria-label="redo">{t('redo')}</button>
      </div>

      <nav className="tabs">
        {(['bg', 'shape', 'look', 'text'] as Tab[]).map((k) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t(`tab_${k}` as never)}</button>
        ))}
      </nav>

      {tab === 'bg' && (
        <section className="panel">
          <div className="row">
            <button onClick={() => runAuto('general')} disabled={!!busy}>{t('bg_auto')}</button>
            <button onClick={() => runAuto('person')} disabled={!!busy}>{t('bg_person')}</button>
          </div>
          <div className="row">
            {(['erase', 'restore', 'move'] as Tool[]).map((k) => (
              <button key={k} className={tool === k ? 'on' : ''} onClick={() => setTool(k)}>{t(`bg_${k}` as never)}</button>
            ))}
          </div>
          <label>{t('bg_size')}<input type="range" min={4} max={90} value={brush} onChange={(e) => setBrush(+e.target.value)} /></label>
          <label>{t('bg_soft')}<input type="range" min={0} max={0.95} step={0.05} value={soft} onChange={(e) => setSoft(+e.target.value)} /></label>
          <label>{t('bg_zoom')}<input type="range" min={1} max={4} step={0.25} value={zoom} onChange={(e) => setZoom(+e.target.value)} /></label>
          <button onClick={() => change(() => doc.mask.set(new Mask(doc.mask.w, doc.mask.h).data))}>{t('bg_reset')}</button>
        </section>
      )}

      {tab === 'shape' && (
        <section className="panel">
          <div className="row">
            {shapes.map((s) => (
              <button key={s} className={doc.shape === s ? 'on' : ''} onClick={() => change(() => { doc.shape = s; })}>{t(`shape_${s}` as never)}</button>
            ))}
          </div>
          <div className="row">
            <button onClick={() => change(() => { doc.rotate = ((doc.rotate + 90) % 360) as StickerDoc['rotate']; })}>{t('rotate')}</button>
            <button onClick={() => change(() => { doc.flip = !doc.flip; })}>{t('flip')}</button>
          </div>
        </section>
      )}

      {tab === 'look' && (
        <section className="panel">
          <label className="check"><input type="checkbox" checked={doc.outline.on} onChange={(e) => change(() => { doc.outline.on = e.target.checked; })} />{t('outline')}
            <input type="color" value={doc.outline.color} onChange={(e) => change(() => { doc.outline.color = e.target.value; })} />
          </label>
          <label>{t('outline_width')}<input type="range" min={2} max={24} value={doc.outline.width} onPointerDown={() => history.push(doc)} onChange={(e) => { doc.outline.width = +e.target.value; rerender(); }} /></label>
          <label className="check"><input type="checkbox" checked={doc.shadow} onChange={(e) => change(() => { doc.shadow = e.target.checked; })} />{t('shadow')}</label>
          {(['brightness', 'contrast', 'saturation'] as const).map((k) => (
            <label key={k}>{t(k)}<input type="range" min={50} max={150} value={doc.adjust[k]} onPointerDown={() => history.push(doc)} onChange={(e) => { doc.adjust[k] = +e.target.value; rerender(); }} /></label>
          ))}
        </section>
      )}

      {tab === 'text' && (
        <section className="panel">
          <button onClick={addText}>{t('text_add')}</button>
          {doc.texts.length > 1 && (
            <div className="row">
              {doc.texts.map((l, i) => <button key={l.id} className={sel === l.id ? 'on' : ''} onClick={() => setSel(l.id)}>{i + 1}</button>)}
            </div>
          )}
          {selected && (
            <>
              <textarea dir="auto" rows={2} value={selected.text} placeholder={t('text_placeholder')} onFocus={() => history.push(doc)} onChange={(e) => editText({ text: e.target.value })} />
              <label>{t('text_font')}
                <select value={selected.font} onChange={(e) => { history.push(doc); editText({ font: e.target.value as FontKey }); }}>
                  {(Object.keys(FONTS) as FontKey[]).map((f) => <option key={f} value={f}>{FONTS[f].family.replace('WS ', '')}</option>)}
                </select>
              </label>
              <label>{t('text_size')}<input type="range" min={16} max={140} value={selected.size} onPointerDown={() => history.push(doc)} onChange={(e) => editText({ size: +e.target.value })} /></label>
              <label>{t('text_color')}<input type="color" value={selected.color} onChange={(e) => { history.push(doc); editText({ color: e.target.value }); }} /></label>
              <label>{t('text_stroke')}<input type="color" value={selected.stroke || '#000000'} onChange={(e) => { history.push(doc); editText({ stroke: e.target.value }); }} />
                <input type="range" min={0} max={14} value={selected.strokeWidth} onPointerDown={() => history.push(doc)} onChange={(e) => editText({ strokeWidth: +e.target.value })} />
              </label>
              <label className="check"><input type="checkbox" checked={selected.shadow} onChange={(e) => { history.push(doc); editText({ shadow: e.target.checked }); }} />{t('text_shadow')}</label>
              <button className="danger" onClick={() => change(() => { doc.texts = doc.texts.filter((l) => l.id !== selected.id); })}>{t('text_delete')}</button>
              <p className="hint">{t('text_hint')}</p>
            </>
          )}
        </section>
      )}

      <button className="primary" onClick={onNext} disabled={!!busy || !doc.mask.hasContent}>{t('next')}</button>
    </div>
  );
}
