export type FinderItemKind =
  | 'folder'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'archive'
  | 'app'
  | 'note';

export interface FinderItem {
  id: string;
  name: string;
  kind: FinderItemKind;
  parentId: string | null;
  modifiedAt: string;
  sizeLabel: string;
  summary: string;
  preview: string;
  tags: string[];
}

export type FinderLocationKind = 'folder' | 'smart' | 'tag';
export type FinderLocationSection = 'favorites' | 'locations' | 'tags';

export interface FinderLocation {
  id: string;
  label: string;
  description: string;
  kind: FinderLocationKind;
  section: FinderLocationSection;
  icon: string;
  rootId?: string;
  tag?: string;
}
