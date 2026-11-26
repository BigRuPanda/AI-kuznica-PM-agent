import { flushSync } from 'react-dom';
import type { MenuLayout } from './menu-layout';

let active: Animation | undefined;
let menuTransition: ViewTransition | undefined;

export function moveMenu(layout: MenuLayout, update: () => void) {
  menuTransition?.skipTransition();
  menuTransition = undefined;
  const workspace = document.querySelector<HTMLElement>('.team-app');
  if (workspace?.dataset.menu === layout || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  if (document.startViewTransition) {
    const transition = document.startViewTransition(() => {
      if (menuTransition === transition) flushSync(update);
    });
    menuTransition = transition;
    const clear = () => {
      if (menuTransition === transition) menuTransition = undefined;
    };
    void transition.finished.then(clear, clear);
    return;
  }
  flushSync(update);
  workspace?.querySelector<HTMLElement>('.side')?.animate?.([
    { opacity: .45, translate: layout === 'top' ? '0 -14px' : '-16px 0' },
    { opacity: 1, translate: '0 0' },
  ], { duration: 220, easing: 'ease-out' });
}

export function moveView(update: () => void) {
  const previous = document.querySelector<HTMLElement>('.workspace-page, .app');
  if (!previous?.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  const opacity = getComputedStyle(previous).opacity;
  active?.cancel();
  const exit = previous.animate([{ opacity }, { opacity: .3 }], {
    duration: 105, easing: 'ease-in-out', fill: 'forwards',
  });
  active = exit;
  void exit.finished.then(() => {
    if (active !== exit) return;
    flushSync(update);
    exit.cancel();
    const next = document.querySelector<HTMLElement>('.workspace-page, .app');
    active = next?.animate([{ opacity: .3 }, { opacity: 1 }], {
      duration: 215, easing: 'ease-out',
    });
  }, () => {});
}
