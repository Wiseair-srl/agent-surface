import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "./Icons.js";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Small non-native listbox: native selects render as OS chrome that clashes
 * with the rest of the UI. Keyboard support follows the ARIA listbox pattern
 * (arrows move, Enter/Space commit, Escape closes, Home/End jump).
 */
export function Select<T extends string>(props: {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  label?: string;
  testId?: string;
}) {
  const { value, options, onChange } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const commit = (index: number): void => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!open && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      setActive(Math.max(0, options.findIndex((o) => o.value === value)));
      setOpen(true);
      return;
    }
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(active);
    }
  };

  return (
    <div className="select" ref={rootRef}>
      <button
        type="button"
        className="select-trigger"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        {...(props.label ? { "aria-label": props.label } : {})}
        {...(props.testId ? { "data-testid": props.testId } : {})}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        <span>{current?.label ?? value}</span>
        <ChevronDown size={13} className="select-caret" />
      </button>
      {open && (
        <ul className="select-list" role="listbox" id={listId} aria-label={props.label ?? "options"}>
          {options.map((option, index) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={`select-option${index === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => commit(index)}
            >
              <span className="select-check">
                {option.value === value && <Check size={13} />}
              </span>
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
