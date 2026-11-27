import { createContext, useContext } from 'react';

export const BridgePages = createContext(false);

function trackingVisibility(showConfluence: boolean) {
  return {
    showConfluence,
    visibleTrackers: (['redmine', 'confluence'] as const).filter(service => service === 'redmine' || showConfluence),
    visibleTrackerStep: (step: string) => showConfluence || !['page_search', 'page_read', 'page_draft'].includes(step),
    hiddenDemoPage: (href: string) => !showConfluence && /#(?:demo-page|knowledge)(?:\/|$)/.test(href),
  };
}

const redmineOnly = trackingVisibility(false);
const withPages = trackingVisibility(true);

export function useTrackingVisibility() {
  return useContext(BridgePages) ? withPages : redmineOnly;
}
