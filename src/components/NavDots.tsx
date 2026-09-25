import { CAROUSEL_COLUMNS } from '../types';
import type { CarouselRow } from '../types';

interface Props {
  col: number;
  row: number;
  rows: CarouselRow[];
}

export function NavDots({ col, row, rows }: Props) {
  return (
    <>
      {/* Horizontal dots (columns) — every row is now a columnar identity row. */}
      <div className="nav-dots-h">
        {CAROUSEL_COLUMNS.map((_, i) => (
          <div key={i} className={`nav-dot${i === col ? ' active' : ''}`} />
        ))}
      </div>

      {/* Vertical dots (identity rows) */}
      <div className="nav-dots-v">
        {rows.map((r, i) => (
          <div
            key={i}
            className={`nav-dot${i === row ? ' active' : ''}${r.type === 'dependant' ? ' child-dot' : ''}`}
          />
        ))}
      </div>
    </>
  );
}
