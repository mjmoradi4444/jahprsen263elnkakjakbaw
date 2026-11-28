const fa = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 });

/** "۳٫۵ ساعت" / "۲ روز و ۴ ساعت" */
export function formatHours(h: number | null | undefined): string {
  if (h === null || h === undefined) return '—';
  if (h < 1) return `${fa.format(Math.max(1, Math.round(h * 60)))} دقیقه`;
  if (h < 48) return `${fa.format(Math.round(h * 10) / 10)} ساعت`;
  const total = Math.round(h);
  const d = Math.floor(total / 24);
  const rest = total % 24;
  return rest ? `${fa.format(d)} روز و ${fa.format(rest)} ساعت` : `${fa.format(d)} روز`;
}
