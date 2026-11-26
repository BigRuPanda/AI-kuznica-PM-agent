// Controls the web interface only. Existing pages and integration APIs remain available.
export const showConfluence = false;

export const visibleTrackers = (['redmine', 'confluence'] as const)
  .filter(service => service === 'redmine' || showConfluence);

export function visibleTrackerStep(step: string) {
  return showConfluence || !['page_search', 'page_read', 'page_draft'].includes(step);
}

export function hiddenDemoPage(href: string) {
  return !showConfluence && /#demo-page(?:\/|$)/.test(href);
}
