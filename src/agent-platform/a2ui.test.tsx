import { describe, expect, it } from 'vitest';
import { createOfficialA2uiSurfaceModel, validateA2uiSurface } from './a2ui';

describe('AIOS restricted A2UI surface', () => {
  it('accepts a bounded graph whose buttons reference a proposed intent', () => {
    const surface = validateA2uiSurface({
      version: '1.0',
      id: 'weather',
      title: 'Weather',
      components: [
        { id: 'summary', type: 'text', text: '18°C and clear' },
        { id: 'open', type: 'button', label: 'Open Settings', intentId: 'intent-1' },
        { id: 'layout', type: 'stack', children: ['summary', 'open'] },
      ],
    }, { validIntentIds: new Set(['intent-1']) });
    expect(surface.components).toHaveLength(3);
  });

  it.each([
    [{ version: '1.0', id: 'x', components: [{ id: 'x', type: 'iframe', url: 'https://evil.test' }] }, 'expected one of'],
    [{ version: '1.0', id: 'x', components: [{ id: 'x', type: 'text', text: 'ok', html: '<b>x</b>' }] }, 'unknown'],
    [{ version: '1.0', id: 'x', components: [{ id: 'a', type: 'stack', children: ['b'] }, { id: 'b', type: 'stack', children: ['a'] }] }, 'root'],
    [{ version: '1.0', id: 'x', components: [{ id: 'a', type: 'button', label: 'Do it', intentId: 'missing' }] }, 'available intent'],
  ])('fails closed on unknown, executable, cyclic, or dangling content', (candidate, message) => {
    expect(() => validateA2uiSurface(candidate, { validIntentIds: new Set(['intent-1']) })).toThrow(message);
  });

  it('adapts the restricted IR through the official A2UI v0.9.1 processor and renderer', () => {
    const model = createOfficialA2uiSurfaceModel({
      version: '1.0', id: 'surface', title: 'Agent result',
      components: [{ id: 'summary', type: 'text', text: 'Ready' }],
    }, [], () => undefined);
    expect(model.componentsModel.get('root')).toBeDefined();
    expect(model.componentsModel.get('summary')).toBeDefined();
  });

  it('rejects a compact DAG whose shared descendants expand beyond the render budget', () => {
    const layers = Array.from({ length: 5 }, (_, layer) =>
      Array.from({ length: 4 }, (_, index) => `layer-${layer}-${index}`));
    const components = layers.flatMap((layer, layerIndex) => layer.map((id) => ({
      id,
      type: 'stack' as const,
      children: layerIndex === layers.length - 1 ? [`leaf-${id}`] : layers[layerIndex + 1],
    })));
    const leaves = layers.at(-1)!.map((id) => ({ id: `leaf-${id}`, type: 'text' as const, text: 'bounded' }));
    expect(() => validateA2uiSurface({
      version: '1.0',
      id: 'dag-bomb',
      components: [
        { id: 'root-stack', type: 'stack', children: layers[0] },
        ...components,
        ...leaves,
      ],
    })).toThrow('expanded surface exceeds 128 render nodes');
  });

  it('rejects duplicate child references within one container', () => {
    expect(() => validateA2uiSurface({
      version: '1.0',
      id: 'duplicate-children',
      components: [
        { id: 'leaf', type: 'text', text: 'once' },
        { id: 'layout', type: 'stack', children: ['leaf', 'leaf'] },
      ],
    })).toThrow('duplicate child reference');
  });

  it('uses collision-free internal ids for adversarial list and item id tuples', () => {
    const model = createOfficialA2uiSurfaceModel({
      version: '1.0',
      id: 'collision-safe',
      components: [
        { id: 'a_b', type: 'list', items: [{ id: 'c', label: 'First' }] },
        { id: 'a', type: 'list', items: [{ id: 'b_c', label: 'Second' }] },
      ],
    }, [], () => undefined);

    const internalItemIds = [...model.componentsModel.entries]
      .map(([id]) => id)
      .filter((id) => id.startsWith('__aios_item_'));
    expect(internalItemIds).toEqual(['__aios_item_0_0', '__aios_item_1_0']);
    expect(new Set(internalItemIds).size).toBe(internalItemIds.length);
  });
});
