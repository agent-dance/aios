import { FINDER_ITEMS, FINDER_LOCATIONS } from './finderData';
import type { FinderItem, FinderLocation } from './finderTypes';

const itemMap = new Map(FINDER_ITEMS.map((item) => [item.id, item]));

const compareByDateDesc = (left: FinderItem, right: FinderItem) =>
  new Date(right.modifiedAt).getTime() - new Date(left.modifiedAt).getTime();

const matchQuery = (item: FinderItem, normalizedQuery: string) => {
  if (!normalizedQuery) {
    return true;
  }

  const haystack = [
    item.name,
    item.summary,
    item.preview,
    item.tags.join(' '),
    item.kind,
  ]
    .join(' ')
    .toLowerCase();

  return haystack.includes(normalizedQuery);
};

export const getFinderItem = (id: string) => itemMap.get(id);

export const getLocationById = (id: string): FinderLocation | undefined =>
  FINDER_LOCATIONS.find((location) => location.id === id);

export const getChildren = (parentId: string) =>
  FINDER_ITEMS.filter((item) => item.parentId === parentId).sort((left, right) => {
    if (left.kind === 'folder' && right.kind !== 'folder') {
      return -1;
    }

    if (left.kind !== 'folder' && right.kind === 'folder') {
      return 1;
    }

    return left.name.localeCompare(right.name);
  });

export const getBreadcrumbItems = (folderId: string) => {
  const breadcrumbs: FinderItem[] = [];
  let current = getFinderItem(folderId);

  while (current) {
    breadcrumbs.unshift(current);
    current = current.parentId ? getFinderItem(current.parentId) : undefined;
  }

  return breadcrumbs;
};

const collectDescendantItems = (rootId: string): FinderItem[] => {
  const descendants: FinderItem[] = [];
  const queue = [...getChildren(rootId)];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    descendants.push(current);
    if (current.kind === 'folder') {
      queue.push(...getChildren(current.id));
    }
  }

  return descendants;
};

export const getVisibleEntries = (
  locationId: string,
  folderId: string | null,
  query: string,
) => {
  const normalizedQuery = query.trim().toLowerCase();
  const location = getLocationById(locationId);

  if (!location) {
    return [];
  }

  if (folderId) {
    return getChildren(folderId).filter((item) => matchQuery(item, normalizedQuery));
  }

  if (location.kind === 'folder' && location.rootId) {
    return getChildren(location.rootId).filter((item) => matchQuery(item, normalizedQuery));
  }

  if (location.kind === 'smart') {
    return FINDER_ITEMS.filter((item) => item.parentId !== null && matchQuery(item, normalizedQuery))
      .sort(compareByDateDesc)
      .slice(0, 10);
  }

  if (location.kind === 'tag' && location.tag) {
    const { tag } = location;
    return FINDER_ITEMS.filter((item) => item.tags.includes(tag) && matchQuery(item, normalizedQuery))
      .sort(compareByDateDesc);
  }

  return [];
};

export const getFolderSummary = (folderId: string) => {
  const folder = getFinderItem(folderId);
  const children = getChildren(folderId);
  const descendantCount = collectDescendantItems(folderId).length;

  return {
    folder,
    childrenCount: children.length,
    descendantCount,
    childPreview: children.slice(0, 3).map((item) => item.name),
  };
};
