import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ChevronRight,
  Download,
  FileAudio2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  Grid2x2,
  History,
  LayoutList,
  Monitor,
  Package,
  PlayCircle,
  Search,
  Tag,
  Users,
} from 'lucide-react';
import { FINDER_LOCATIONS } from './finderData';
import { getBreadcrumbItems, getFinderItem, getFolderSummary, getLocationById, getVisibleEntries } from './finderUtils';
import type { FinderItem, FinderItemKind } from './finderTypes';

type FinderViewMode = 'grid' | 'list';

const surfaceStyle = {
  display: 'grid',
  gridTemplateColumns: '220px minmax(0, 1fr) 280px',
  gridTemplateRows: 'minmax(0, 1fr)',
  height: '100%',
  minHeight: 0,
  background: 'linear-gradient(180deg, rgba(248,250,255,0.92), rgba(235,239,248,0.88))',
  color: '#0f172a',
  overflow: 'hidden',
} as const;

const contentHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  padding: '16px 20px 12px',
  borderBottom: '1px solid rgba(148, 163, 184, 0.22)',
} as const;

const panelTitleStyle = {
  margin: 0,
  fontSize: 18,
  fontWeight: 700,
  letterSpacing: '-0.02em',
} as const;

const iconMap = {
  history: History,
  monitor: Monitor,
  'folder-open': FolderOpen,
  download: Download,
  'grid-2x2': Grid2x2,
  users: Users,
  archive: Archive,
  'tag-priority': Tag,
  'tag-projects': Tag,
  'tag-shared': Tag,
} as const;

const kindIconMap: Record<FinderItemKind, typeof Folder> = {
  folder: Folder,
  image: FileImage,
  document: FileText,
  audio: FileAudio2,
  video: PlayCircle,
  archive: Archive,
  app: Package,
  note: FileText,
};

const kindTintMap: Record<FinderItemKind, string> = {
  folder: '#4f8cf7',
  image: '#34c3ff',
  document: '#6c7a95',
  audio: '#f59e0b',
  video: '#8b5cf6',
  archive: '#ef4444',
  app: '#10b981',
  note: '#fb7185',
};

const sectionLabels = {
  favorites: 'Favorites',
  locations: 'Locations',
  tags: 'Tags',
} as const;

const formatItemType = (item: FinderItem) => {
  switch (item.kind) {
    case 'folder':
      return 'Folder';
    case 'image':
      return 'Image';
    case 'document':
      return 'Document';
    case 'audio':
      return 'Audio';
    case 'video':
      return 'Video';
    case 'archive':
      return 'Archive';
    case 'app':
      return 'Application';
    case 'note':
      return 'Note';
    default:
      return 'Item';
  }
};

export interface FinderAppProps {
  isActive?: boolean;
}

export function FinderApp({ isActive = true }: FinderAppProps) {
  const [activeLocationId, setActiveLocationId] = useState('desktop');
  const [navigationStack, setNavigationStack] = useState<string[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>('handoff-packet');
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<FinderViewMode>('grid');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const fallbackLocation = FINDER_LOCATIONS[0]!;
  const activeLocation = getLocationById(activeLocationId) ?? fallbackLocation;
  const currentFolderId = navigationStack.at(-1) ?? (activeLocation.kind === 'folder' ? activeLocation.rootId ?? null : null);
  const visibleEntries = getVisibleEntries(activeLocation.id, currentFolderId, searchQuery);
  const selectedEntry =
    (selectedEntryId ? getFinderItem(selectedEntryId) : undefined) ??
    (visibleEntries.length > 0 ? visibleEntries[0] : undefined);

  const breadcrumbItems = currentFolderId ? getBreadcrumbItems(currentFolderId) : [];
  const displayBreadcrumbs = breadcrumbItems.length > 0
    ? breadcrumbItems.map((item) => ({ id: item.id, name: item.name, isFolder: true }))
    : [{ id: activeLocation.id, name: activeLocation.label, isFolder: false }];
  const folderSummary = currentFolderId ? getFolderSummary(currentFolderId) : null;
  const previewContext = useMemo(() => {
    if (selectedEntry) {
      return {
        title: selectedEntry.name,
        badge: formatItemType(selectedEntry),
        summary: selectedEntry.summary,
        preview: selectedEntry.preview,
        size: selectedEntry.sizeLabel,
        modifiedAt: selectedEntry.modifiedAt,
        tags: selectedEntry.tags,
      };
    }

    if (folderSummary?.folder) {
      return {
        title: folderSummary.folder.name,
        badge: 'Folder Overview',
        summary: folderSummary.folder.summary,
        preview:
          folderSummary.childPreview.length > 0
            ? `Top items: ${folderSummary.childPreview.join(', ')}.`
            : folderSummary.folder.preview,
        size: `${folderSummary.childrenCount} visible items`,
        modifiedAt: folderSummary.folder.modifiedAt,
        tags: folderSummary.folder.tags,
      };
    }

    return {
      title: activeLocation.label,
      badge: activeLocation.kind === 'tag' ? 'Tag Collection' : 'Smart Folder',
      summary: activeLocation.description,
      preview: searchQuery
        ? `Search results for "${searchQuery}" are shown here.`
        : 'Select an item to inspect its metadata and quick preview.',
      size: `${visibleEntries.length} items`,
      modifiedAt: 'Live scope',
      tags: [],
    };
  }, [activeLocation.description, activeLocation.kind, activeLocation.label, folderSummary, searchQuery, selectedEntry, visibleEntries.length]);

  useEffect(() => {
    if (!selectedEntryId && visibleEntries.length > 0) {
      setSelectedEntryId(visibleEntries[0]?.id ?? null);
      return;
    }

    if (selectedEntryId && !visibleEntries.some((item) => item.id === selectedEntryId)) {
      setSelectedEntryId(visibleEntries[0]?.id ?? null);
    }
  }, [selectedEntryId, visibleEntries]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const metaOrCtrl = event.metaKey || event.ctrlKey;

      if (metaOrCtrl && key === 'f') {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (metaOrCtrl && key === '1') {
        event.preventDefault();
        setViewMode('grid');
        return;
      }

      if (metaOrCtrl && key === '2') {
        event.preventDefault();
        setViewMode('list');
        return;
      }

      if (event.key === 'Escape') {
        if (searchQuery) {
          setSearchQuery('');
          return;
        }
      }

      if (visibleEntries.length === 0) {
        return;
      }

      const currentIndex = Math.max(
        0,
        visibleEntries.findIndex((item) => item.id === selectedEntryId),
      );
      const gridStep = 3;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const nextIndex = viewMode === 'grid'
          ? Math.min(currentIndex + gridStep, visibleEntries.length - 1)
          : Math.min(currentIndex + 1, visibleEntries.length - 1);
        setSelectedEntryId(visibleEntries[nextIndex]?.id ?? null);
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        const previousIndex = viewMode === 'grid'
          ? Math.max(currentIndex - gridStep, 0)
          : Math.max(currentIndex - 1, 0);
        setSelectedEntryId(visibleEntries[previousIndex]?.id ?? null);
      }

      if (event.key === 'ArrowRight' && viewMode === 'grid') {
        event.preventDefault();
        setSelectedEntryId(visibleEntries[Math.min(currentIndex + 1, visibleEntries.length - 1)]?.id ?? null);
      }

      if (event.key === 'ArrowLeft' && viewMode === 'grid') {
        event.preventDefault();
        setSelectedEntryId(visibleEntries[Math.max(currentIndex - 1, 0)]?.id ?? null);
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const entry = visibleEntries[currentIndex];
        if (entry) {
          if (entry.kind === 'folder') {
            setNavigationStack((current) => [...current, entry.id]);
            setSelectedEntryId(null);
          } else {
            setSelectedEntryId(entry.id);
          }
        }
      }

      if (event.key === 'Backspace' && currentFolderId) {
        event.preventDefault();
        if (navigationStack.length > 0) {
          setNavigationStack((current) => current.slice(0, -1));
          setSelectedEntryId(null);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentFolderId, isActive, navigationStack.length, searchQuery, selectedEntryId, viewMode, visibleEntries]);

  const handleLocationChange = (locationId: string) => {
    setActiveLocationId(locationId);
    setNavigationStack([]);
    setSelectedEntryId(null);
    setSearchQuery('');
  };

  const handleOpenEntry = (entry: FinderItem) => {
    if (entry.kind === 'folder') {
      setNavigationStack((current) => [...current, entry.id]);
      setSelectedEntryId(null);
      return;
    }

    setSelectedEntryId(entry.id);
  };

  return (
    <div className="finder-app" style={surfaceStyle}>
      <aside
        className="finder-sidebar"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          padding: '16px 14px',
          minHeight: 0,
          overflowY: 'auto',
          background: 'rgba(241, 245, 249, 0.72)',
          borderRight: '1px solid rgba(148, 163, 184, 0.18)',
        }}
      >
        <div className="finder-sidebar-header">
          <p style={{ margin: 0, fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Finder
          </p>
          <h2 style={{ ...panelTitleStyle, marginTop: 6 }}>Workspace</h2>
        </div>

        {(['favorites', 'locations', 'tags'] as const).map((section) => (
          <div className={`finder-sidebar-section finder-sidebar-section-${section}`} key={section}>
            <p style={{ margin: '0 0 8px', fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {sectionLabels[section]}
            </p>
            <div style={{ display: 'grid', gap: 6 }}>
              {FINDER_LOCATIONS.filter((location) => location.section === section).map((location) => {
                const Icon = iconMap[location.icon as keyof typeof iconMap] ?? Folder;
                const active = location.id === activeLocationId;
                return (
                  <button
                    className={`finder-sidebar-item${active ? ' is-active' : ''}`}
                    key={location.id}
                    onClick={() => handleLocationChange(location.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 12px',
                      borderRadius: 12,
                      border: '1px solid transparent',
                      background: active ? 'rgba(255,255,255,0.96)' : 'transparent',
                      boxShadow: active ? '0 10px 30px rgba(15, 23, 42, 0.08)' : 'none',
                      color: '#0f172a',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                    type="button"
                  >
                    <Icon size={16} color={section === 'tags' ? '#f97316' : '#5b7cff'} />
                    <span style={{ fontSize: 14, fontWeight: active ? 700 : 500 }}>{location.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </aside>

      <section className="finder-browser" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header className="finder-toolbar" style={contentHeaderStyle}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#475569', flexWrap: 'wrap' }}>
              {displayBreadcrumbs.map((crumb, index) => (
                <div key={crumb.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {index > 0 ? <ChevronRight size={14} color="#94a3b8" /> : null}
                  <button
                    type="button"
                    className="finder-breadcrumb"
                    onClick={() => {
                      if (crumb.isFolder) {
                        const nextStack = breadcrumbItems.slice(0, index + 1).map((item) => item.id);
                        setNavigationStack(nextStack);
                        setSelectedEntryId(null);
                      }
                    }}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      color: '#0f172a',
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {crumb.name}
                  </button>
                </div>
              ))}
            </div>
            <p style={{ margin: '6px 0 0', fontSize: 13, color: '#64748b' }}>{activeLocation.description}</p>
          </div>

          <div className="finder-toolbar-controls" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label
              className="finder-search"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                minWidth: 220,
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid rgba(148, 163, 184, 0.26)',
                background: 'rgba(255,255,255,0.88)',
              }}
            >
              <Search size={16} color="#64748b" />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={`Search ${activeLocation.label}`}
                className="finder-search-input"
                style={{
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  width: '100%',
                  fontSize: 14,
                  color: '#0f172a',
                }}
              />
            </label>

            <div
              className="finder-view-toggle"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: 4,
                borderRadius: 14,
                background: 'rgba(255,255,255,0.88)',
                border: '1px solid rgba(148, 163, 184, 0.22)',
              }}
            >
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                aria-pressed={viewMode === 'grid'}
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  border: 'none',
                  background: viewMode === 'grid' ? 'rgba(91, 124, 255, 0.14)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <Grid2x2 size={16} color={viewMode === 'grid' ? '#3757ff' : '#64748b'} />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                aria-pressed={viewMode === 'list'}
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  border: 'none',
                  background: viewMode === 'list' ? 'rgba(91, 124, 255, 0.14)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <LayoutList size={16} color={viewMode === 'list' ? '#3757ff' : '#64748b'} />
              </button>
            </div>
          </div>
        </header>

        <div className="finder-browser-content" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          <div
            className={`finder-entry-grid finder-entry-grid-${viewMode}`}
            style={{
              display: viewMode === 'grid' ? 'grid' : 'flex',
              flexDirection: viewMode === 'list' ? 'column' : undefined,
              gridTemplateColumns: viewMode === 'grid' ? 'repeat(auto-fill, minmax(170px, 1fr))' : undefined,
              gap: 14,
              padding: 20,
              overflow: 'auto',
              minHeight: 0,
              alignContent: 'start',
            }}
          >
            {visibleEntries.length === 0 ? (
              <div
                className="finder-empty-state"
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  minHeight: 220,
                  borderRadius: 20,
                  border: '1px dashed rgba(148, 163, 184, 0.38)',
                  background: 'rgba(255,255,255,0.55)',
                  color: '#64748b',
                  textAlign: 'center',
                  padding: 24,
                }}
              >
                <div>
                  <p style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 600 }}>No items match this view</p>
                  <p style={{ margin: 0, fontSize: 13 }}>Try a different location or clear the current search query.</p>
                </div>
              </div>
            ) : (
              visibleEntries.map((entry) => {
                const Icon = kindIconMap[entry.kind];
                const selected = entry.id === selectedEntry?.id;
                const tint = kindTintMap[entry.kind];
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={`finder-entry finder-entry-${viewMode}${selected ? ' is-selected' : ''}`}
                    onClick={() => setSelectedEntryId(entry.id)}
                    onDoubleClick={() => handleOpenEntry(entry)}
                    style={{
                      display: viewMode === 'grid' ? 'flex' : 'grid',
                      gridTemplateColumns: viewMode === 'list' ? '44px minmax(0, 1.3fr) minmax(100px, 0.8fr) 110px 90px' : undefined,
                      alignItems: 'center',
                      gap: 14,
                      width: '100%',
                      minHeight: viewMode === 'grid' ? 132 : 64,
                      padding: viewMode === 'grid' ? '18px 16px' : '12px 16px',
                      borderRadius: 18,
                      border: selected ? `1px solid ${tint}` : '1px solid rgba(148, 163, 184, 0.18)',
                      background: selected ? 'rgba(255,255,255,0.96)' : 'rgba(255,255,255,0.72)',
                      boxShadow: selected ? '0 16px 40px rgba(15, 23, 42, 0.12)' : '0 4px 18px rgba(148, 163, 184, 0.08)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      color: '#0f172a',
                    }}
                  >
                    <div
                      style={{
                        display: 'grid',
                        placeItems: 'center',
                        width: 44,
                        height: 44,
                        borderRadius: 14,
                        background: `${tint}18`,
                        flexShrink: 0,
                      }}
                    >
                      <Icon size={22} color={tint} />
                    </div>

                    {viewMode === 'grid' ? (
                      <div style={{ minWidth: 0 }}>
                        <p style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {entry.name}
                        </p>
                        <p style={{ margin: '0 0 10px', fontSize: 12, color: '#64748b', minHeight: 32 }}>{entry.summary}</p>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, color: '#64748b' }}>
                          <span>{formatItemType(entry)}</span>
                          <span>{entry.sizeLabel}</span>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div style={{ minWidth: 0 }}>
                          <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {entry.name}
                          </p>
                          <p style={{ margin: 0, fontSize: 12, color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {entry.summary}
                          </p>
                        </div>
                        <span style={{ fontSize: 13, color: '#64748b' }}>{formatItemType(entry)}</span>
                        <span style={{ fontSize: 13, color: '#64748b' }}>{entry.modifiedAt}</span>
                        <span style={{ fontSize: 13, color: '#64748b' }}>{entry.sizeLabel}</span>
                      </>
                    )}
                  </button>
                );
              })
            )}
          </div>

          <footer
            className="finder-statusbar"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '12px 20px',
              borderTop: '1px solid rgba(148, 163, 184, 0.18)',
              fontSize: 12,
              color: '#64748b',
              background: 'rgba(255,255,255,0.58)',
            }}
          >
            <span>{visibleEntries.length} items in view</span>
            <span>{selectedEntry ? `${selectedEntry.name} selected` : 'No item selected'}</span>
          </footer>
        </div>
      </section>

      <aside
        className="finder-preview"
        style={{
          display: 'flex',
          flexDirection: 'column',
          padding: 20,
          gap: 18,
          borderLeft: '1px solid rgba(148, 163, 184, 0.18)',
          background: 'rgba(248, 250, 252, 0.78)',
        }}
      >
        <div className="finder-preview-card" style={{ display: 'grid', gap: 16 }}>
          <div
            style={{
              minHeight: 160,
              borderRadius: 24,
              padding: 18,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              background: 'linear-gradient(145deg, rgba(59,130,246,0.16), rgba(14,165,233,0.08), rgba(255,255,255,0.96))',
              border: '1px solid rgba(148, 163, 184, 0.18)',
            }}
          >
            <span style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#475569' }}>
              {previewContext.badge}
            </span>
            <div>
              <h3 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 800, letterSpacing: '-0.03em' }}>{previewContext.title}</h3>
              <p style={{ margin: 0, color: '#334155', lineHeight: 1.5 }}>{previewContext.summary}</p>
            </div>
          </div>

          <div
            className="finder-preview-details"
            style={{
              display: 'grid',
              gap: 12,
              padding: 16,
              borderRadius: 20,
              background: 'rgba(255,255,255,0.78)',
              border: '1px solid rgba(148, 163, 184, 0.18)',
            }}
          >
            <div>
              <p style={{ margin: '0 0 4px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#94a3b8' }}>
                Quick Look
              </p>
              <p style={{ margin: 0, fontSize: 14, color: '#0f172a', lineHeight: 1.6 }}>{previewContext.preview}</p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
              <div>
                <p style={{ margin: '0 0 4px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#94a3b8' }}>
                  Modified
                </p>
                <p style={{ margin: 0, fontSize: 13, color: '#334155' }}>{previewContext.modifiedAt}</p>
              </div>
              <div>
                <p style={{ margin: '0 0 4px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#94a3b8' }}>
                  Size
                </p>
                <p style={{ margin: 0, fontSize: 13, color: '#334155' }}>{previewContext.size}</p>
              </div>
            </div>
            <div>
              <p style={{ margin: '0 0 6px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#94a3b8' }}>
                Tags
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(previewContext.tags.length > 0 ? previewContext.tags : ['browser', 'preview']).map((tagValue) => (
                  <span
                    className="finder-preview-tag"
                    key={tagValue}
                    style={{
                      padding: '6px 10px',
                      borderRadius: 999,
                      background: 'rgba(15, 23, 42, 0.06)',
                      color: '#334155',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {tagValue}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

export default FinderApp;
