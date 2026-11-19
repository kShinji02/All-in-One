import { MessageSquare, Radio, Clapperboard, Users, type LucideIcon } from 'lucide-react';

/**
 * Registro central dos módulos do All-in-One.
 *
 * Cada módulo futuro vive em src/features/<id>/ e expõe sua própria view.
 * Ao implementar um módulo, mude o status para 'available' e associe a view;
 * até lá ele aparece apenas como item de roteiro, sem interação.
 */
export type FeatureId = 'chat' | 'participants' | 'communication' | 'media';
export type FeatureStatus = 'planned' | 'available';

export interface FeatureModule {
  id: FeatureId;
  name: string;
  description: string;
  icon: LucideIcon;
  status: FeatureStatus;
  accent: 'neon' | 'electric';
}

export const featureModules: readonly FeatureModule[] = [
  {
    id: 'chat',
    name: 'Chat',
    description: 'Conversa em tempo real entre os participantes da atividade.',
    icon: MessageSquare,
    status: 'planned',
    accent: 'neon',
  },
  {
    id: 'participants',
    name: 'Participantes',
    description: 'Quem está na atividade, com presença e papéis.',
    icon: Users,
    status: 'planned',
    accent: 'electric',
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
