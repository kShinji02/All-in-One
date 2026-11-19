import { Events } from '@discord/embedded-app-sdk';
import { userAvatarUrl } from '@/discord/cdn';
import { COMMAND_TIMEOUT_MS } from '@/discord/config';
import { getDiscordSdk } from '@/discord/sdk';
import type { DiscordParticipant } from '@/discord/types';
import { withTimeout } from '@/lib/with-timeout';

/**
 * Participantes da instância da Activity.
 *
 * Usa a instância única do SDK (getDiscordSdk). Segundo a documentação oficial,
 * nem o comando nem o evento exigem escopos OAuth2.
 */

const EVENT = Events.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE;

interface RawParticipant {
  id: string;
  username: string;
  discriminator: string;
  global_name?: string | null;
  avatar?: string | null;
  bot: boolean;
  nickname?: string;
}

type ParticipantsHandler = (participants: DiscordParticipant[]) => void;

function toParticipant(raw: RawParticipant): DiscordParticipant {
  const globalName = raw.global_name ?? null;
  return {
    id: raw.id,
    username: raw.username,
    displayName: raw.nickname || globalName || raw.username,
    globalName,
    avatarUrl: userAvatarUrl(raw),
    bot: raw.bot,
  };
}

/** Normaliza a lista: remove duplicados por id, mantendo a última ocorrência. */
export function normalizeParticipants(raw: readonly RawParticipant[]): DiscordParticipant[] {
  const byId = new Map<string, DiscordParticipant>();
  for (const item of raw) byId.set(item.id, toParticipant(item));
  return [...byId.values()];
}

export async function fetchParticipants(): Promise<DiscordParticipant[]> {
  const { participants } = await withTimeout(
    getDiscordSdk().commands.getActivityInstanceConnectedParticipants(),
    COMMAND_TIMEOUT_MS,
    'getActivityInstanceConnectedParticipants',
  );
  return normalizeParticipants(participants);
}

/* ------------------------------------------------------------------
 * Hub de assinatura
 *
 * Um único listener é registrado no SDK e repassa cada atualização aos
 * consumidores (componentes). Motivos:
 * - O SDK só envia SUBSCRIBE ao Discord para o primeiro listener e só
 *   executa eventBus.off depois de um UNSUBSCRIBE bem-sucedido. Com um
 *   listener único, a contagem interna do SDK fica previsível.
 * - Os consumidores ficam num Set próprio, então removê-los ao desmontar
 *   é garantido mesmo se o Discord não responder.
 * - As operações são serializadas para que montagens/desmontagens rápidas
 *   (StrictMode) não se entrelacem.
 * ------------------------------------------------------------------ */

const consumers = new Set<ParticipantsHandler>();
let attached = false;
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function hubListener(data: { participants: RawParticipant[] }) {
  const participants = normalizeParticipants(data.participants);
  for (const handler of consumers) handler(participants);
}

async function attach(): Promise<void> {
  if (attached) return;
  const sdk = getDiscordSdk();
  try {
    await withTimeout(sdk.subscribe(EVENT, hubListener), COMMAND_TIMEOUT_MS, 'SUBSCRIBE');
    attached = true;
  } catch (error) {
    // O SDK registra o listener antes de enviar o SUBSCRIBE. Tenta desfazer para
    // que uma nova tentativa envie o SUBSCRIBE novamente. Com tempo limite, a
    // fila nunca fica presa esperando uma resposta que não vem.
    await withTimeout(sdk.unsubscribe(EVENT, hubListener), COMMAND_TIMEOUT_MS, 'UNSUBSCRIBE').catch(
      () => undefined,
    );
    throw error;
  }
}

async function detachIfUnused(): Promise<void> {
  if (!attached || consumers.size > 0) return;
  try {
    await withTimeout(getDiscordSdk().unsubscribe(EVENT, hubListener), COMMAND_TIMEOUT_MS, 'UNSUBSCRIBE');
    attached = false;
  } catch {
    // Se o UNSUBSCRIBE falhar, o listener continua no SDK e é reaproveitado
    // pelo próximo consumidor; nenhum consumidor recebe eventos sem estar no Set.
  }
}

/**
 * Recebe a lista completa de participantes a cada ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE.
 * Retorna a função de cancelamento (idempotente).
 */
export async function subscribeParticipants(handler: ParticipantsHandler): Promise<() => Promise<void>> {
  consumers.add(handler);
  try {
    await serialize(attach);
  } catch (error) {
    consumers.delete(handler);
    throw error;
  }

  let active = true;
  return async () => {
    if (!active) return;
    active = false;
    consumers.delete(handler);
    await serialize(detachIfUnused);
  };
}
