import { MessageProcessor, type A2uiClientAction } from '@a2ui/web_core/v0_9';
import { A2uiSurface as OfficialA2uiSurface, basicCatalog } from '@a2ui/react/v0_9';
import { useMemo } from 'react';
import { validateOsIntent, type OsIntent } from './intents';
import {
  assertArray,
  assertEnum,
  assertExactKeys,
  assertRecord,
  assertString,
  ValidationError,
} from './validation';

type Tone = 'neutral' | 'positive' | 'warning' | 'critical';

export type A2uiComponent =
  | { readonly id: string; readonly type: 'text'; readonly text: string; readonly tone?: Tone }
  | { readonly id: string; readonly type: 'heading'; readonly text: string; readonly level: 1 | 2 | 3 }
  | { readonly id: string; readonly type: 'button'; readonly label: string; readonly intentId: string; readonly variant?: 'default' | 'primary' | 'borderless' }
  | { readonly id: string; readonly type: 'stack' | 'group'; readonly children: readonly string[] }
  | { readonly id: string; readonly type: 'status'; readonly label: string; readonly value: string; readonly tone?: Tone }
  | { readonly id: string; readonly type: 'list'; readonly items: readonly { readonly id: string; readonly label: string; readonly description?: string }[] };

export interface A2uiSurface {
  readonly version: '1.0';
  readonly id: string;
  readonly title?: string;
  readonly components: readonly A2uiComponent[];
}

const ID_PATTERN = /^(?!__aios_)(?!root$)[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TONES: readonly Tone[] = ['neutral', 'positive', 'warning', 'critical'];

interface ValidateSurfaceOptions {
  readonly path?: string;
  readonly validIntentIds?: ReadonlySet<string>;
}

const validateId = (value: unknown, path: string): string =>
  assertString(value, path, { min: 1, max: 128, pattern: ID_PATTERN });

const validateComponent = (value: unknown, path: string, validIntentIds?: ReadonlySet<string>): A2uiComponent => {
  const record = assertRecord(value, path);
  const type = assertEnum(record.type, ['text', 'heading', 'button', 'stack', 'group', 'status', 'list'] as const, `${path}.type`);
  const id = validateId(record.id, `${path}.id`);
  if (type === 'text') {
    assertExactKeys(record, ['id', 'type', 'text'], ['tone'], path);
    return Object.freeze({ id, type, text: assertString(record.text, `${path}.text`, { min: 1, max: 2_000 }), ...(record.tone === undefined ? {} : { tone: assertEnum(record.tone, TONES, `${path}.tone`) }) });
  }
  if (type === 'heading') {
    assertExactKeys(record, ['id', 'type', 'text', 'level'], [], path);
    if (record.level !== 1 && record.level !== 2 && record.level !== 3) throw new ValidationError(`${path}.level`, 'expected 1, 2, or 3');
    return Object.freeze({ id, type, text: assertString(record.text, `${path}.text`, { min: 1, max: 240 }), level: record.level });
  }
  if (type === 'button') {
    assertExactKeys(record, ['id', 'type', 'label', 'intentId'], ['variant'], path);
    const intentId = validateId(record.intentId, `${path}.intentId`);
    if (validIntentIds && !validIntentIds.has(intentId)) throw new ValidationError(`${path}.intentId`, 'button must reference an available intent');
    return Object.freeze({
      id,
      type,
      label: assertString(record.label, `${path}.label`, { min: 1, max: 120 }),
      intentId,
      ...(record.variant === undefined ? {} : { variant: assertEnum(record.variant, ['default', 'primary', 'borderless'], `${path}.variant`) }),
    });
  }
  if (type === 'stack' || type === 'group') {
    assertExactKeys(record, ['id', 'type', 'children'], [], path);
    return Object.freeze({ id, type, children: Object.freeze(assertArray(record.children, `${path}.children`, { max: 32, item: validateId })) });
  }
  if (type === 'status') {
    assertExactKeys(record, ['id', 'type', 'label', 'value'], ['tone'], path);
    return Object.freeze({
      id,
      type,
      label: assertString(record.label, `${path}.label`, { min: 1, max: 120 }),
      value: assertString(record.value, `${path}.value`, { min: 1, max: 240 }),
      ...(record.tone === undefined ? {} : { tone: assertEnum(record.tone, TONES, `${path}.tone`) }),
    });
  }
  assertExactKeys(record, ['id', 'type', 'items'], [], path);
  const items = assertArray(record.items, `${path}.items`, {
    max: 32,
    item: (entry, itemPath) => {
      const item = assertRecord(entry, itemPath);
      assertExactKeys(item, ['id', 'label'], ['description'], itemPath);
      return Object.freeze({
        id: validateId(item.id, `${itemPath}.id`),
        label: assertString(item.label, `${itemPath}.label`, { min: 1, max: 160 }),
        ...(item.description === undefined ? {} : { description: assertString(item.description, `${itemPath}.description`, { max: 400 }) }),
      });
    },
  });
  return Object.freeze({ id, type, items: Object.freeze(items) });
};

export const validateA2uiSurface = (value: unknown, options: ValidateSurfaceOptions = {}): A2uiSurface => {
  const path = options.path ?? 'surface';
  const record = assertRecord(value, path);
  assertExactKeys(record, ['version', 'id', 'components'], ['title'], path);
  if (record.version !== '1.0') throw new ValidationError(`${path}.version`, 'unsupported surface version');
  const components = assertArray(record.components, `${path}.components`, {
    min: 1,
    max: 64,
    item: (entry, itemPath) => validateComponent(entry, itemPath, options.validIntentIds),
  });
  const ids = new Set<string>();
  let renderNodeCount = record.title === undefined ? 1 : 2;
  for (const component of components) {
    if (ids.has(component.id)) throw new ValidationError(`${path}.components`, `duplicate component id ${component.id}`);
    ids.add(component.id);
    renderNodeCount += component.type === 'button' ? 2 : component.type === 'list' ? 1 + component.items.length : 1;
    if (component.type === 'list' && new Set(component.items.map((item) => item.id)).size !== component.items.length) {
      throw new ValidationError(`${path}.components.${component.id}.items`, 'duplicate list item id');
    }
  }
  if (renderNodeCount > 128) throw new ValidationError(`${path}.components`, 'expanded surface exceeds 128 render nodes');
  const referenced = new Set<string>();
  for (const component of components) {
    if (component.type !== 'stack' && component.type !== 'group') continue;
    if (new Set(component.children).size !== component.children.length) {
      throw new ValidationError(`${path}.components.${component.id}.children`, 'duplicate child reference');
    }
    for (const child of component.children) {
      if (!ids.has(child)) throw new ValidationError(`${path}.components.${component.id}.children`, `unknown child ${child}`);
      referenced.add(child);
    }
  }
  const byId = new Map(components.map((component) => [component.id, component]));
  let expandedNodeCount = record.title === undefined ? 1 : 2;
  const visit = (id: string, ancestry: ReadonlySet<string>, depth: number): void => {
    expandedNodeCount += 1;
    if (expandedNodeCount > 128) throw new ValidationError(`${path}.components`, 'expanded surface exceeds 128 render nodes');
    if (depth > 8) throw new ValidationError(`${path}.components.${id}`, 'component depth exceeds 8');
    if (ancestry.has(id)) throw new ValidationError(`${path}.components.${id}`, 'component graph contains a cycle');
    const component = byId.get(id);
    if (!component || (component.type !== 'stack' && component.type !== 'group')) return;
    const next = new Set(ancestry).add(id);
    for (const child of component.children) visit(child, next, depth + 1);
  };
  const roots = components.filter((component) => !referenced.has(component.id));
  if (roots.length === 0) throw new ValidationError(`${path}.components`, 'surface has no root component');
  for (const root of roots) visit(root.id, new Set(), 1);
  return Object.freeze({
    version: '1.0',
    id: validateId(record.id, `${path}.id`),
    ...(record.title === undefined ? {} : { title: assertString(record.title, `${path}.title`, { min: 1, max: 160 }) }),
    components: Object.freeze([...components]),
  });
};

interface AiosA2uiSurfaceProps {
  readonly surface: A2uiSurface;
  readonly intents: readonly OsIntent[];
  readonly onIntent: (intent: OsIntent) => void;
}

const toOfficialComponents = (surface: A2uiSurface): readonly Record<string, unknown>[] => {
  const referenced = new Set(surface.components.flatMap((component) =>
    component.type === 'stack' || component.type === 'group' ? component.children : []));
  const roots = surface.components.filter((component) => !referenced.has(component.id)).map((component) => component.id);
  const result: Record<string, unknown>[] = [];
  if (surface.title) result.push({ id: '__aios_title', component: 'Text', text: surface.title, variant: 'h2' });
  for (const [componentIndex, component] of surface.components.entries()) {
    switch (component.type) {
      case 'text': result.push({ id: component.id, component: 'Text', text: component.text, variant: 'body' }); break;
      case 'heading': result.push({ id: component.id, component: 'Text', text: component.text, variant: `h${component.level}` }); break;
      case 'button':
        result.push({ id: `__aios_label_${componentIndex}`, component: 'Text', text: component.label, variant: 'body' });
        result.push({ id: component.id, component: 'Button', child: `__aios_label_${componentIndex}`, variant: component.variant ?? 'default', action: { event: { name: 'aios.intent', context: { intentId: component.intentId } } } });
        break;
      case 'stack':
      case 'group': result.push({ id: component.id, component: 'Column', children: [...component.children] }); break;
      case 'status': result.push({ id: component.id, component: 'Text', text: `${component.label}: ${component.value}`, variant: 'body' }); break;
      case 'list': {
        const childIds = component.items.map((_item, itemIndex) => `__aios_item_${componentIndex}_${itemIndex}`);
        component.items.forEach((item, index) => result.push({ id: childIds[index], component: 'Text', text: item.description ? `${item.label} — ${item.description}` : item.label, variant: 'body' }));
        result.push({ id: component.id, component: 'List', children: childIds, direction: 'vertical', listStyle: 'unordered' });
        break;
      }
    }
  }
  result.push({
    id: 'root',
    component: 'Column',
    children: [...(surface.title ? ['__aios_title'] : []), ...roots],
  });
  return result;
};

const actionIntentId = (action: A2uiClientAction): string | undefined => {
  const actionRecord = action as unknown as Record<string, unknown>;
  const context = actionRecord.context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return undefined;
  const intentId = (context as Record<string, unknown>).intentId;
  return typeof intentId === 'string' ? intentId : undefined;
};

/**
 * AIOS validates and narrows its restricted Surface IR, then delegates schema
 * processing and rendering to the official A2UI v0.9.1 implementation.
 */
export const AiosA2uiSurface = ({ surface: candidate, intents: candidateIntents, onIntent }: AiosA2uiSurfaceProps) => {
  const validatedIntents = useMemo(() => candidateIntents.map((intent, index) => {
    return validateOsIntent(intent, `intents[${index}]`);
  }), [candidateIntents]);
  const intentById = useMemo(() => new Map(validatedIntents.map((intent) => [intent.id, intent])), [validatedIntents]);
  const surface = useMemo(() => validateA2uiSurface(candidate, { validIntentIds: new Set(intentById.keys()) }), [candidate, intentById]);
  const model = useMemo(() => createOfficialA2uiSurfaceModel(surface, validatedIntents, onIntent), [onIntent, surface, validatedIntents]);
  return <OfficialA2uiSurface surface={model} />;
};

export const createOfficialA2uiSurfaceModel = (
  candidate: A2uiSurface,
  candidateIntents: readonly OsIntent[],
  onIntent: (intent: OsIntent) => void,
) => {
  const intents = candidateIntents.map((intent, index) => validateOsIntent(intent, `intents[${index}]`));
  const intentById = new Map(intents.map((intent) => [intent.id, intent]));
  const surface = validateA2uiSurface(candidate, { validIntentIds: new Set(intentById.keys()) });
  const processor = new MessageProcessor([basicCatalog], (action) => {
    const intentId = actionIntentId(action);
    const intent = intentId ? intentById.get(intentId) : undefined;
    if (intent) onIntent(intent);
  }, { version: 'v0.9.1' });
  processor.processMessages([
    { version: 'v0.9.1', createSurface: { surfaceId: surface.id, catalogId: basicCatalog.id } },
    { version: 'v0.9.1', updateComponents: { surfaceId: surface.id, components: [...toOfficialComponents(surface)] } },
  ]);
  const created = processor.model.surfacesMap.get(surface.id);
  if (!created) throw new ValidationError('surface', 'official A2UI processor did not create the surface');
  return created;
};
