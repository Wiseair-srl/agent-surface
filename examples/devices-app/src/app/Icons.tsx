/**
 * The icon set: 16px stroke geometry on a 16-unit grid, 1.5 stroke, round
 * caps and joins. Drawn here rather than pulled from a package because the
 * example ships no CSS framework and no icon dependency — and because emoji
 * or text glyphs (⌄ ✓ ×) carry their own vertical bearing and never optically
 * centre in a square button.
 *
 * Everything is `currentColor` and `display: block`, so an icon inherits the
 * meaning of whatever it sits in: green for a settled call, amber for a
 * domain plane, red for an error.
 */

type IconProps = { size?: number; className?: string };

function Svg(props: IconProps & { children: React.ReactNode; label?: string }) {
  const size = props.size ?? 16;
  return (
    <svg
      className={props.className ? `icon ${props.className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={props.label ? undefined : true}
      {...(props.label ? { role: "img", "aria-label": props.label } : { focusable: false })}
    >
      {props.children}
    </svg>
  );
}

export const ChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.25 8 10.25 12 6.25" />
  </Svg>
);

export const ChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.25 4 10.25 8 6.25 12" />
  </Svg>
);

export const ArrowLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12.5 8H3.5M7 4.5 3.5 8 7 11.5" />
  </Svg>
);

export const ArrowUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 12.5V3.5M4.5 7 8 3.5 11.5 7" />
  </Svg>
);

export const Check = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
  </Svg>
);

/** Settled with an error — a circle so it reads as a status, not a close button. */
export const XCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M6.1 6.1 9.9 9.9M9.9 6.1 6.1 9.9" />
  </Svg>
);

export const X = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4 12 12M12 4 4 12" />
  </Svg>
);

/** In flight. The arc is 3/4 of a circle so the rotation is legible. */
export const Loader = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.25a5.75 5.75 0 1 1-5.06 3.02" />
  </Svg>
);

/** Blocked / waiting on a person. */
export const Hand = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M6.4 6v4M9.6 6v4" />
  </Svg>
);

export const AlertTriangle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.75 14 13H2z" />
    <path d="M8 6.75v3M8 11.4v.1" />
  </Svg>
);

export const Stop = (p: IconProps) => (
  <svg
    className="icon"
    width={p.size ?? 16}
    height={p.size ?? 16}
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />
  </svg>
);

export const Play = (p: IconProps) => (
  <svg
    className="icon"
    width={p.size ?? 16}
    height={p.size ?? 16}
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M5.5 3.6a.9.9 0 0 1 1.37-.77l5.4 3.4a.9.9 0 0 1 0 1.54l-5.4 3.4A.9.9 0 0 1 5.5 10.4z" />
  </svg>
);

export const Search = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7.2" cy="7.2" r="4.2" />
    <path d="M10.4 10.4 13.2 13.2" />
  </Svg>
);

/** The surface: stacked planes. Doubles as the inspector's affordance. */
export const Layers = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.2 14 5.4 8 8.6 2 5.4z" />
    <path d="M2 8.9 8 12.1l6-3.2" />
  </Svg>
);

export const Sliders = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 5.5h4M10 5.5h3M3 10.5h3M9 10.5h4" />
    <circle cx="8.6" cy="5.5" r="1.6" />
    <circle cx="7.4" cy="10.5" r="1.6" />
  </Svg>
);

/** Sort affordance: neutral, ascending, descending — one glyph, three states. */
export const Sort = (p: IconProps & { dir?: "asc" | "desc" | null }) => (
  <Svg size={p.size} className={p.className}>
    <path d="M5 6.5 5 12.5M5 12.5 3 10.5M5 12.5 7 10.5" opacity={p.dir === "desc" ? 1 : 0.35} />
    <path d="M11 9.5 11 3.5M11 3.5 9 5.5M11 3.5 13 5.5" opacity={p.dir === "asc" ? 1 : 0.35} />
  </Svg>
);
