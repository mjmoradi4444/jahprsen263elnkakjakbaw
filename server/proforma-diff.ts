/**
 * Compares the items of a previous proforma with the revised one.
 *
 * Items come from the server's own reading of each PDF whenever available (authoritative), and
 * fall back to parsing the items text when a proforma was entered manually or as an image.
 * Matching is by item code when both sides have one, otherwise by normalised description.
 */

export interface ComparableItem {
  code: string;
  description: string;
  qty: number | null;
  unit: string;
  unitPriceRial: number | null;
  lineTotalRial: number | null;
}

export interface ItemRef {
  code: string;
  description: string;
  unit: string;
}

export interface ItemsDiff {
  added: Array<ItemRef & { qty: number | null }>;
  removed: Array<ItemRef & { qty: number | null }>;
  qtyChanged: Array<ItemRef & { oldQty: number | null; newQty: number | null }>;
  priceChanged: Array<ItemRef & { oldUnitPriceRial: number; newUnitPriceRial: number }>;
  unchanged: number;
}

export interface RevisionChanges {
  items: ItemsDiff;
  hasItemChanges: boolean;
}

function normalize(s: string): string {
  return s
    .replace(/[‌‎‏]/g, ' ')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses the items text. Understands the format the auto-fill writes
 * ("شرح × 100 عدد (کد 1310021007)") as well as free lines; one item per line or per "+".
 */
export function parseItemsText(text: string): ComparableItem[] {
  const lines = normalize(text.replace(/\r/g, ''))
    ? text
        .replace(/\r/g, '')
        .split(/\n|\s\+\s/)
        .map((l) => normalize(l))
        .filter(Boolean)
    : [];
  return lines.map((line) => {
    let rest = line;
    let code = '';
    const codeMatch = rest.match(/\(\s*کد\s*([0-9A-Za-z-]+)\s*\)\s*$/);
    if (codeMatch) {
      code = codeMatch[1];
      rest = rest.slice(0, codeMatch.index).trim();
    }
    let qty: number | null = null;
    let unit = '';
    const qtyMatch = rest.match(/^(.*?)\s*[×xX*]\s*([0-9]+(?:\.[0-9]+)?)\s*(.*)$/);
    if (qtyMatch) {
      rest = qtyMatch[1].trim();
      qty = Number(qtyMatch[2]);
      unit = qtyMatch[3].trim();
    }
    return { code, description: rest, qty, unit, unitPriceRial: null, lineTotalRial: null };
  });
}

function keyOf(i: ComparableItem, useCodes: boolean): string {
  return useCodes && i.code ? `c:${i.code}` : `d:${normalize(i.description).toLowerCase()}`;
}

/** Sums quantities of duplicate lines so each key appears once. */
function aggregate(items: ComparableItem[], useCodes: boolean): Map<string, ComparableItem> {
  const m = new Map<string, ComparableItem>();
  for (const it of items) {
    const k = keyOf(it, useCodes);
    const prev = m.get(k);
    if (!prev) {
      m.set(k, { ...it });
    } else {
      prev.qty = prev.qty === null || it.qty === null ? (prev.qty ?? it.qty) : prev.qty + it.qty;
    }
  }
  return m;
}

export function diffItems(oldItems: ComparableItem[], newItems: ComparableItem[]): ItemsDiff {
  // Match by code only if every item on both sides has one; otherwise descriptions are compared.
  const useCodes = oldItems.length > 0 && newItems.length > 0 && [...oldItems, ...newItems].every((i) => i.code);
  const oldMap = aggregate(oldItems, useCodes);
  const newMap = aggregate(newItems, useCodes);
  const ref = (i: ComparableItem): ItemRef => ({ code: i.code, description: i.description, unit: i.unit });

  const diff: ItemsDiff = { added: [], removed: [], qtyChanged: [], priceChanged: [], unchanged: 0 };
  for (const [k, n] of newMap) {
    const o = oldMap.get(k);
    if (!o) {
      diff.added.push({ ...ref(n), qty: n.qty });
      continue;
    }
    let changed = false;
    if (o.qty !== n.qty) {
      diff.qtyChanged.push({ ...ref(n), oldQty: o.qty, newQty: n.qty });
      changed = true;
    }
    if (o.unitPriceRial !== null && n.unitPriceRial !== null && o.unitPriceRial !== n.unitPriceRial) {
      diff.priceChanged.push({ ...ref(n), oldUnitPriceRial: o.unitPriceRial, newUnitPriceRial: n.unitPriceRial });
      changed = true;
    }
    if (!changed) diff.unchanged++;
  }
  for (const [k, o] of oldMap) {
    if (!newMap.has(k)) diff.removed.push({ ...ref(o), qty: o.qty });
  }
  return diff;
}

export function buildRevisionChanges(oldItems: ComparableItem[], newItems: ComparableItem[]): RevisionChanges {
  const items = diffItems(oldItems, newItems);
  return {
    items,
    hasItemChanges: items.added.length + items.removed.length + items.qtyChanged.length + items.priceChanged.length > 0,
  };
}

/** Safely parses stored items JSON; returns null when absent or malformed. */
export function parseStoredItems(json: string | null | undefined): ComparableItem[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return null;
    return v
      .filter((x) => x && typeof x === 'object')
      .map((x) => ({
        code: String(x.code ?? ''),
        description: String(x.description ?? ''),
        qty: typeof x.qty === 'number' ? x.qty : null,
        unit: String(x.unit ?? ''),
        unitPriceRial: typeof x.unitPriceRial === 'number' ? x.unitPriceRial : null,
        lineTotalRial: typeof x.lineTotalRial === 'number' ? x.lineTotalRial : null,
      }));
  } catch {
    return null;
  }
}
