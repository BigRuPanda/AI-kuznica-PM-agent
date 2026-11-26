export type MenuLayout = 'left' | 'top';
export const menuLayoutKey = 'pm-menu-layout';

export function readMenuLayout(): MenuLayout {
  try {
    if (localStorage.getItem(menuLayoutKey) === 'top') return 'top';
  } catch {}
  return 'left';
}
