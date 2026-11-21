import { describe, expect, it } from 'vitest';
import { ChatView } from '@/features/chat/ChatView';
import { ParticipantsView } from '@/features/participants/ParticipantsView';
import { featureModules, isAvailable, modulesInSlot } from '@/features/registry';

describe('registro de módulos (fonte única da Home)', () => {
  it('ids únicos e nomes únicos (sem duplicação)', () => {
    const ids = featureModules.map((m) => m.id);
    const names = featureModules.map((m) => m.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it('todo módulo disponível declara view e área; nenhum planejado tem view', () => {
    for (const module of featureModules) {
      if (isAvailable(module)) {
        expect(module.View, module.id).toBeTypeOf('function');
        expect(['main', 'aside'], module.id).toContain(module.slot);
      } else {
        expect(module, module.id).not.toHaveProperty('View');
        expect(module, module.id).not.toHaveProperty('slot');
      }
    }
  });

  it('cada view aparece uma única vez no registro', () => {
    const views = featureModules.filter(isAvailable).map((m) => m.View);
    expect(new Set(views).size).toBe(views.length);
  });

  it('chat ocupa a área principal; participantes, a coluna lateral', () => {
    expect(modulesInSlot('main').map((m) => [m.id, m.View])).toEqual([['chat', ChatView]]);
    expect(modulesInSlot('aside').map((m) => [m.id, m.View])).toEqual([['participants', ParticipantsView]]);
  });

  it('status do roteiro: chat e participantes disponíveis; comunicação e mídia planejados', () => {
    expect(featureModules.map((m) => [m.id, m.status])).toEqual([
      ['chat', 'available'],
      ['participants', 'available'],
      ['communication', 'planned'],
      ['media', 'planned'],
    ]);
  });
});
