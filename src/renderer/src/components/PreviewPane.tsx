import { useEffect, useRef, useState } from "react";
import { usePanelInset, usePreviewFreeze, useViewport } from "../store";
import {
  FRAME_ASPECT,
  FRAME_INSET,
  FRAME_DATA_URI,
} from "../../../shared/iphone-frame";

/**
 * Hosts the native WebContentsView preview. We don't render the preview in the
 * DOM — instead this element reserves space and continuously reports its
 * rectangle to the main process, which positions the native view on top. A
 * ResizeObserver + window resize keeps the native view glued to this slot.
 *
 * Mobile viewport: fit an iPhone bezel (contain) in the slot and report the
 * native view's bounds as the bezel's SCREEN CUTOUT — so the previewed app
 * renders at a phone width, framed by the device. The bezel <img> sits in the
 * DOM (behind the native view); the native view covers the cutout on top, so the
 * opaque frame shows around it.
 *
 * Freeze-frame: while `usePreviewFreeze.frozen` (an overlay like the branch
 * dropdown is open), the live view — which always paints above the DOM — is
 * swapped for a pixel-identical snapshot <img> at the same rect, so the overlay
 * can stack on top of a still-visible preview.
 */
type Rect = { left: number; top: number; width: number; height: number };
type ViewRect = Rect & { radius: number };

/** The native view rounds all four corners at this radius via setBorderRadius.
 *  Its corners are genuinely transparent, so the card behind (a DOM rounded-rect
 *  with a 1px border) shows through them — the card's border reads as a clean
 *  rounded frame around the preview, no painting/masks. 15 = the card's inner
 *  radius (16px outer − 1px border). */
export const DESKTOP_CORNER_RADIUS = 15;

export default function PreviewPane(): React.JSX.Element {
  const slotRef = useRef<HTMLDivElement>(null);
  const browserMode = !!window.__PRAXIS_WEB_CONFIG__;
  const viewport = useViewport((s) => s.viewport);
  const frozen = usePreviewFreeze((s) => s.frozen);
  // Right-edge strip reserved by the floating prop panel: desktop narrows the
  // view; mobile re-centers the whole bezel in what's left (shrinking the
  // ~390px cutout would collapse the phone screen to a sliver).
  const inset = usePanelInset((s) => s.inset);
  const bottomInset = usePanelInset((s) => s.bottom);
  const [bezel, setBezel] = useState<Rect | null>(null);
  // Where the native view sits, relative to the slot — the freeze <img> matches it.
  const [viewRect, setViewRect] = useState<ViewRect | null>(null);
  const [freezeImg, setFreezeImg] = useState<string | null>(null);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!browserMode) return;
    const receive = (event: Event): void => {
      const detail = (event as CustomEvent<{ url: string | null }>).detail;
      setBrowserUrl(detail?.url ?? null);
    };
    window.addEventListener("praxis:web-preview", receive);
    return () => window.removeEventListener("praxis:web-preview", receive);
  }, [browserMode]);

  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;

    const report = (): void => {
      const r = el.getBoundingClientRect();
      // The area the preview may occupy (the panel strip on the right + the code
      // drawer at the bottom, when open, are off-limits).
      const availW = Math.max(120, r.width - inset);
      const availH = Math.max(120, r.height - bottomInset);
      if (viewport === "mobile") {
        // Fit the bezel within the available area (contain), capped so it's not huge.
        let h = Math.min(availH - 32, 880);
        let w = h * FRAME_ASPECT;
        if (w > availW - 32) {
          w = Math.max(120, availW - 32);
          h = w / FRAME_ASPECT;
        }
        const bx = r.x + (availW - w) / 2;
        const by = r.y + (availH - h) / 2;
        // The native view fills the bezel's screen cutout (inset % of the frame),
        // with rounded corners to match the phone's screen so it fits the frame.
        const cutW = w * (1 - (FRAME_INSET.left + FRAME_INSET.right) / 100) + 1;
        const cut = {
          x: bx + (w * FRAME_INSET.left) / 100,
          y: by + (h * FRAME_INSET.top) / 100 - 1,
          width: cutW,
          height: h * (1 - (FRAME_INSET.top + FRAME_INSET.bottom) / 100) + 2,
          radius: Math.round(cutW * 0.1),
        };
        window.api.preview.setBounds(cut);
        setViewRect({
          left: cut.x - r.x,
          top: cut.y - r.y,
          width: cut.width,
          height: cut.height,
          radius: cut.radius,
        });
        setBezel({ left: bx - r.x, top: by - r.y, width: w, height: h });
      } else {
        // Flush inside the card body, natively rounded to the card's inner radius.
        window.api.preview.setBounds({
          x: r.x,
          y: r.y,
          width: availW,
          height: availH,
          radius: DESKTOP_CORNER_RADIUS,
        });
        setViewRect({
          left: 0,
          top: 0,
          width: availW,
          height: availH,
          radius: DESKTOP_CORNER_RADIUS,
        });
        setBezel(null);
      }
    };

    report();
    // Draw the iPhone bezel INSIDE the preview page (over the app, click-through)
    // in mobile; the DOM <img> below only supplies the device body around it.
    window.api.preview.setFrame(viewport === "mobile");
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener("resize", report);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
      // No slot → no native view. Zero the bounds so closing the last project
      // (or any path that unmounts the panes) can't leave the preview floating
      // over the empty state with stale bounds — visible AND click-eating. On a
      // viewport switch the effect re-runs and report() restores bounds at once.
      window.api.preview.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    };
  }, [viewport, inset, bottomInset]);

  // Freeze under overlays: capture FIRST (identical pixels); unfreeze restores
  // the live view and drops the snapshot.
  useEffect(() => {
    if (!frozen) {
      // Show the live view FIRST, and keep the snapshot up briefly — the show
      // lands in the compositor a few frames later, and removing the img in the
      // same tick flashed the card background on every menu close.
      window.api.preview.setDragging(false);
      const t = setTimeout(() => setFreezeImg(null), 120);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    void window.api.preview.capture().then((url) => {
      if (cancelled) return;
      setFreezeImg(url);
      // No snapshot (e.g. empty view)? Hide anyway — blank beats covering the menu.
      if (!url) {
        window.api.preview.setDragging(true);
        usePreviewFreeze.getState().setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [frozen]);

  // Hide the live view only AFTER the snapshot <img> has painted (double rAF
  // past the commit) — hiding in the same tick blanked the preview for a frame,
  // which read as a flicker every time a dropdown opened. `ready` then unblocks
  // the overlay (dropdowns wait for it before opening).
  useEffect(() => {
    if (!frozen || !freezeImg) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        window.api.preview.setDragging(true);
        usePreviewFreeze.getState().setReady(true);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [frozen, freezeImg]);

  return (
    <div
      ref={slotRef}
      className={`preview-slot ${viewport === "mobile" ? "preview-slot--mobile" : ""}`}
    >
      {bezel && (
        <img
          src={FRAME_DATA_URI}
          alt=""
          draggable={false}
          className="preview-bezel"
          style={{
            left: bezel.left,
            top: bezel.top,
            width: bezel.width,
            height: bezel.height,
          }}
        />
      )}
      {browserMode && browserUrl && viewRect && (
        <iframe
          id="praxis-web-preview"
          title="Project preview"
          src={browserUrl}
          className="preview-web-frame"
          allow="clipboard-read; clipboard-write"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
          style={{
            left: viewRect.left,
            top: viewRect.top,
            width: viewRect.width,
            height: viewRect.height,
            borderRadius: viewRect.radius,
          }}
        />
      )}
      {frozen && freezeImg && viewRect && (
        <img
          src={freezeImg}
          alt=""
          draggable={false}
          className="preview-freeze"
          style={{
            left: viewRect.left,
            top: viewRect.top,
            width: viewRect.width,
            height: viewRect.height,
            borderRadius: viewRect.radius,
          }}
        />
      )}
    </div>
  );
}
