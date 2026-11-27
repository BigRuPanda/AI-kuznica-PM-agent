import { createContext, useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import './ui-hints.css';

const HintsEnabled = createContext(false);
const gap = 8;

type ActiveHint = { target: HTMLElement; text: string; viewKey: string };

export type UiHintsPreference = { enabled: boolean; setEnabled: (enabled: boolean) => void };

export function useUiHintsPreference(userId: string): UiHintsPreference {
  const key = 'pm-ui-hints/' + userId;
  const [enabled, setState] = useState(() => {
    try { return localStorage.getItem(key) !== 'off'; } catch { return true; }
  });

  function setEnabled(value: boolean) {
    setState(value);
    try {
      if (value) localStorage.removeItem(key);
      else localStorage.setItem(key, 'off');
    } catch {}
  }

  return { enabled, setEnabled };
}

export function HelpMarker({ label, hint }: { label: string; hint: string }) {
  if (!useContext(HintsEnabled)) return null;
  return <button type="button" className="ui-help-marker" aria-label={label} data-ui-hint={hint}>?</button>;
}

function positionHint(node: HTMLDivElement, target: HTMLElement) {
  const bounds = target.getBoundingClientRect();
  const { clientWidth, clientHeight } = document.documentElement;
  const { offsetWidth: width, offsetHeight: height } = node;
  const center = bounds.left + bounds.width / 2;
  const left = Math.max(gap, Math.min(center - width / 2, clientWidth - width - gap));
  const above = bounds.top - height - gap;
  const below = above < gap;
  const top = below ? Math.max(gap, Math.min(bounds.bottom + gap, clientHeight - height - gap)) : above;
  const inView = bounds.bottom > 0 && bounds.top < clientHeight && bounds.right > 0 && bounds.left < clientWidth;
  node.style.visibility = inView ? '' : 'hidden';
  node.style.left = left + 'px';
  node.style.top = top + 'px';
  node.dataset.placement = below ? 'below' : 'above';
  node.style.setProperty('--ui-hint-arrow-x', Math.max(gap, Math.min(center - left, width - gap)) + 'px');
}

function HintPopup({ hint, popup }: { hint: ActiveHint; popup: RefObject<HTMLDivElement | null> }) {
  const id = useId();
  const target = hint.target;
  const host = target.closest<HTMLDialogElement>('dialog[open]') ?? document.body;

  useLayoutEffect(() => {
    const node = popup.current;
    if (!node || !target.isConnected) return;
    node.showPopover();
    positionHint(node, target);

    const descriptions = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    target.setAttribute('aria-describedby', [...descriptions, id].join(' '));
    return () => {
      const remaining = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(value => value && value !== id);
      if (remaining.length) target.setAttribute('aria-describedby', remaining.join(' '));
      else target.removeAttribute('aria-describedby');
      if (node.matches(':popover-open')) node.hidePopover();
    };
  }, [id, popup, target]);

  return createPortal(
    <div ref={popup} id={id} popover="manual" className="ui-hint-tooltip" role="tooltip">{hint.text}</div>,
    host,
  );
}

function targetOf(value: EventTarget | null) {
  return value instanceof Element ? value.closest<HTMLElement>('[data-ui-hint]') : null;
}

function contains(container: Node | null | undefined, value: EventTarget | null) {
  return !!container && value instanceof Node && container.contains(value);
}

export function UiHintsScope({ enabled, viewKey, children }: { enabled: boolean; viewKey: string; children: ReactNode }) {
  const popup = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState<ActiveHint | null>(null);

  useLayoutEffect(() => {
    setHint(null);
    if (!enabled) return;

    let showTimer: number | undefined;
    let hideTimer: number | undefined;
    let pending: HTMLElement | null = null;
    let active: HTMLElement | null = null;
    let keyboard = true;
    const observer = new MutationObserver(() => {
      if (active && !active.isConnected) dismiss();
    });

    function cancelShow() {
      window.clearTimeout(showTimer);
      pending = null;
    }

    function dismiss() {
      cancelShow();
      window.clearTimeout(hideTimer);
      observer.disconnect();
      if (active) {
        active = null;
        setHint(null);
      }
    }

    function show(target: HTMLElement) {
      dismiss();
      const text = target.dataset.uiHint;
      if (!text || !target.isConnected) return;
      active = target;
      setHint({ target, text, viewKey });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    function over(event: PointerEvent) {
      if (event.pointerType !== 'mouse') return;
      if (contains(popup.current, event.target)) {
        window.clearTimeout(hideTimer);
        return;
      }
      const target = targetOf(event.target);
      if (!target || contains(target, event.relatedTarget)) return;
      if (target === active) {
        window.clearTimeout(hideTimer);
        return;
      }
      dismiss();
      pending = target;
      showTimer = window.setTimeout(() => {
        cancelShow();
        if (target.matches(':hover')) show(target);
      }, 250);
    }

    function out(event: PointerEvent) {
      if (event.pointerType !== 'mouse') return;
      const from = targetOf(event.target);
      if (from && from === pending && !contains(from, event.relatedTarget)) cancelShow();
      if (!active || (from !== active && !contains(popup.current, event.target))) return;
      if (contains(active, event.relatedTarget) || contains(popup.current, event.relatedTarget)) return;
      if (keyboard && active === document.activeElement && active.matches(':focus-visible')) return;
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(dismiss, 140);
    }

    function focusIn(event: FocusEvent) {
      const target = targetOf(event.target);
      if (keyboard && target?.matches(':focus-visible')) show(target);
    }

    function focusOut(event: FocusEvent) {
      const target = targetOf(event.target);
      if (target && (target === active || target === pending) && !contains(target, event.relatedTarget)) dismiss();
    }

    function pointerDown() {
      keyboard = false;
      dismiss();
    }

    function keyDown(event: KeyboardEvent) {
      keyboard = true;
      if (event.key !== 'Escape') return;
      const node = popup.current;
      if (node?.matches(':popover-open') && node.style.visibility !== 'hidden') {
        event.preventDefault();
        event.stopPropagation();
      }
      dismiss();
    }

    function dialogClosed(event: Event) {
      if (active && event.target instanceof HTMLDialogElement && event.target.contains(active)) dismiss();
    }

    function scroll() {
      if (!active) return;
      if (keyboard && active === document.activeElement && popup.current) positionHint(popup.current, active);
      else dismiss();
    }

    const listeners = new AbortController();
    const options = { capture: true, signal: listeners.signal };
    document.addEventListener('pointerover', over, options);
    document.addEventListener('pointerout', out, options);
    document.addEventListener('focusin', focusIn, options);
    document.addEventListener('focusout', focusOut, options);
    document.addEventListener('pointerdown', pointerDown, options);
    document.addEventListener('click', dismiss, options);
    document.addEventListener('keydown', keyDown, options);
    document.addEventListener('close', dialogClosed, options);
    window.addEventListener('scroll', scroll, options);
    window.addEventListener('resize', dismiss, options);
    return () => {
      listeners.abort();
      cancelShow();
      window.clearTimeout(hideTimer);
      observer.disconnect();
    };
  }, [enabled, viewKey]);

  return <HintsEnabled.Provider value={enabled}>
    {children}
    {enabled && hint?.viewKey === viewKey && <HintPopup hint={hint} popup={popup} />}
  </HintsEnabled.Provider>;
}
