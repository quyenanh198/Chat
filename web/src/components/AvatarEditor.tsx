import { useEffect, useRef, useState } from 'react';

// Square crop editor: drag to position, slider to zoom, exports 512×512 JPEG.
// Pure canvas math — no dependencies.

const VIEW = 256; // on-screen crop viewport (CSS pixels)
const OUT = 512; // exported square

interface Props {
  file: File;
  onCancel: () => void;
  onSave: (blob: Blob) => void;
  busy?: boolean;
}

export default function AvatarEditor({ file, onCancel, onSave, busy }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // cover-fit baseline: at scale 1 the image exactly covers the viewport.
  const base = img ? Math.max(VIEW / img.width, VIEW / img.height) : 1;
  const drawnW = img ? img.width * base * scale : 0;
  const drawnH = img ? img.height * base * scale : 0;

  function clampOffset(x: number, y: number) {
    const maxX = Math.max(0, (drawnW - VIEW) / 2);
    const maxY = Math.max(0, (drawnH - VIEW) / 2);
    return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    setOffset(clampOffset(d.baseX + (e.clientX - d.startX), d.baseY + (e.clientY - d.startY)));
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  function save() {
    if (!img) return;
    const canvas = document.createElement('canvas');
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext('2d')!;
    const k = base * scale;
    // top-left of the drawn image inside the viewport:
    const px = VIEW / 2 + offset.x - drawnW / 2;
    const py = VIEW / 2 + offset.y - drawnH / 2;
    // viewport [0,VIEW] maps to source rect:
    const sx = -px / k;
    const sy = -py / k;
    const sw = VIEW / k;
    ctx.drawImage(img, sx, sy, sw, sw, 0, 0, OUT, OUT);
    canvas.toBlob((blob) => blob && onSave(blob), 'image/jpeg', 0.9);
  }

  return (
    <div className="modal-overlay avatar-editor-overlay">
      <div className="modal avatar-editor">
        <h2>Chỉnh ảnh đại diện</h2>
        <div
          className="avatar-crop"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {img && (
            <img
              src={img.src}
              alt=""
              draggable={false}
              style={{
                width: drawnW,
                height: drawnH,
                transform: `translate(${VIEW / 2 + offset.x - drawnW / 2}px, ${VIEW / 2 + offset.y - drawnH / 2}px)`,
              }}
            />
          )}
          <div className="avatar-crop-ring" />
        </div>
        <input
          type="range"
          min={1}
          max={3}
          step={0.01}
          value={scale}
          onChange={(e) => {
            const next = Number(e.target.value);
            setScale(next);
            setOffset((o) => clampOffset(o.x, o.y));
          }}
        />
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            Huỷ
          </button>
          <button type="button" className="primary-button" onClick={save} disabled={busy || !img}>
            {busy ? 'Đang lưu…' : 'Lưu'}
          </button>
        </div>
      </div>
    </div>
  );
}
