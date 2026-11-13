import { filterOptions, type SelectOption } from "./filter.ts";

export interface SelectConfig {
  placeholder: string;
  filterPlaceholder: string;
  emptyMessage: string;
  /** Text typed into the filter that should be offered as a value of its own. */
  freeValue?: (text: string) => SelectOption | null;
  onChange: (value: string) => void;
}

export interface Select {
  setOptions(options: SelectOption[]): void;
  readonly value: string;
}

/**
 * A select with a filter, in the spirit of PrimeVue's Select: the trigger
 * shows the chosen label, clicking it opens a panel with a filter box on top
 * and the list below. Arrows move, Enter picks, Escape or a click outside
 * closes.
 */
export function createSelect(root: HTMLElement, config: SelectConfig): Select {
  root.classList.add("select");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "select-trigger";
  trigger.disabled = true;
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const label = document.createElement("span");
  label.className = "select-label placeholder";
  label.textContent = config.placeholder;
  trigger.append(label);

  const panel = document.createElement("div");
  panel.className = "select-panel";
  panel.hidden = true;
  const filter = document.createElement("input");
  filter.type = "text";
  filter.className = "select-filter";
  filter.placeholder = config.filterPlaceholder;
  filter.autocomplete = "off";
  const list = document.createElement("ul");
  list.setAttribute("role", "listbox");
  panel.append(filter, list);
  root.append(trigger, panel);

  let options: SelectOption[] = [];
  let shown: SelectOption[] = [];
  let active = 0;
  let value = "";

  const render = () => {
    shown = filterOptions(options, filter.value);
    const free = config.freeValue?.(filter.value.trim());
    if (free && !options.some((o) => o.value === free.value)) shown.push(free);
    active = Math.min(active, Math.max(shown.length - 1, 0));

    list.innerHTML = "";
    if (shown.length === 0) {
      const empty = document.createElement("li");
      empty.className = "select-empty";
      empty.textContent = config.emptyMessage;
      list.append(empty);
      return;
    }
    shown.forEach((option, i) => {
      const item = document.createElement("li");
      item.setAttribute("role", "option");
      item.textContent = option.label;
      item.setAttribute("aria-selected", String(option.value === value));
      if (i === active) item.classList.add("active");
      // mousedown, not click: picking must win over the filter's blur.
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        pick(option);
      });
      item.addEventListener("mousemove", () => {
        if (active !== i) {
          active = i;
          render();
        }
      });
      list.append(item);
    });
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  };

  const open = () => {
    filter.value = "";
    active = Math.max(options.findIndex((o) => o.value === value), 0);
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    render();
    filter.focus();
  };

  const close = () => {
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };

  const pick = (option: SelectOption) => {
    value = option.value;
    label.textContent = option.label;
    label.classList.remove("placeholder");
    close();
    trigger.focus();
    config.onChange(value);
  };

  trigger.addEventListener("click", () => (panel.hidden ? open() : close()));
  filter.addEventListener("input", () => {
    active = 0;
    render();
  });
  filter.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      active = Math.min(Math.max(active + step, 0), Math.max(shown.length - 1, 0));
      render();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = shown[active];
      if (option) pick(option);
    } else if (event.key === "Escape") {
      close();
      trigger.focus();
    } else if (event.key === "Tab") {
      close();
    }
  });
  document.addEventListener("mousedown", (event) => {
    if (!panel.hidden && !root.contains(event.target as Node)) close();
  });

  return {
    setOptions(next) {
      options = next;
      trigger.disabled = false;
    },
    get value() {
      return value;
    },
  };
}
