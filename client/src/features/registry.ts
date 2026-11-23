import type { ComponentType } from 'react';
import { MessageSquare, MonitorUp, Radio, Clapperboard, Users, type LucideIcon } from 'lucide-react';
import { ChatView } from '@/features/chat/ChatView';
import { ParticipantsView } from '@/features/participants/ParticipantsView';
import { ScreenShareView } from '@/features/screenshare/ScreenShareView';

/**
 * Registro central dos módulos do All-in-One — fonte única da Home.
 *
 * Cada módulo vive em src/features/<id>/ e expõe sua própria view. Um módulo
 * "available" PRECISA declarar a view e onde ela aparece na Home (`slot`); um módulo
 * "planned" não tem view e aparece só no roteiro. A Home não importa views de módulo
 * diretamente: tudo o que ela monta vem daqui.
 */
export type FeatureId = 'chat' | 'participants' | 'screenshare' | 'communication' | 'media';
export type FeatureStatus = 'planned' | 'available';

/** Áreas da Home: `main` ocupa a maior parte (chat); `aside` é a coluna lateral. */
export type HomeSlot = 'main' | 'aside';

interface FeatureBase {
  id: FeatureId;
  name: string;
  description: string;
  icon: LucideIcon;
  accent: 'neon' | 'electric';
  /** O recurso é do próprio Discord; o módulo só orienta (o roteiro mostra "Pelo Discord"). */
  native?: boolean;
}

export interface PlannedFeature extends FeatureBase {
  status: 'planned';
}

export interface AvailableFeature extends FeatureBase {
  status: 'available';
  slot: HomeSlot;
  View: ComponentType;
}

export type FeatureModule = PlannedFeature | AvailableFeature;

export const featureModules: readonly FeatureModule[] = [
  {
    id: 'chat',
    name: 'Chat',
    description: 'Conversa em tempo real entre os participantes da atividade.',
    icon: MessageSquare,
    status: 'available',
    accent: 'neon',
    slot: 'main',
    View: ChatView,
  },
  {
    id: 'participants',
    name: 'Participantes',
    description: 'Quem está conectado à instância da Activity, atualizado em tempo real.',
    icon: Users,
    status: 'available',
    accent: 'electric',
    slot: 'aside',
    View: ParticipantsView,
  },
  {
    id: 'screenshare',
    name: 'Compartilhar tela',
    // Recurso nativo do Discord: a Activity só orienta, não captura a tela (o SDK não oferece isso).
    description: 'Feito pelo próprio Discord, na chamada de voz; o painel mostra onde fica o botão.',
    icon: MonitorUp,
    status: 'available',
    native: true,
    accent: 'neon',
    slot: 'aside',
    View: ScreenShareView,
  },
  {
    id: 'communication',
    name: 'Comunicação',
    description: 'Sinalização e eventos sincronizados entre os usuários.',
    icon: Radio,
    status: 'planned',
    accent: 'neon',
  },
  {
    id: 'media',
    name: 'Player de mídia',
    description: 'Reprodução de mídia sincronizada para todo o canal.',
    icon: Clapperboard,
    status: 'planned',
    accent: 'electric',
  },
];

export const isAvailable = (module: FeatureModule): module is AvailableFeature => module.status === 'available';

/** Módulos disponíveis de uma área da Home, na ordem do registro. */
export function modulesInSlot(slot: HomeSlot, modules: readonly FeatureModule[] = featureModules): AvailableFeature[] {
  return modules.filter(isAvailable).filter((module) => module.slot === slot);
}
