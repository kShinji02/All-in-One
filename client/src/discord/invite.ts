import { getDiscordSdk } from '@/discord/sdk';

/**
 * Resultado de pedir ao Discord para abrir o convite da Activity.
 * - opened: o Discord aceitou o comando (o próprio Discord mostra a tela de convite).
 * - unavailable: o SDK ainda não concluiu a conexão; nada é feito.
 * - unsupported: este cliente do Discord não oferece o comando (ex.: versão antiga).
 * - failed: o Discord recusou o comando ou ele falhou.
 */
export type InviteResult = 'opened' | 'unavailable' | 'unsupported' | 'failed';

/**
 * Abre a tela de convite do PRÓPRIO Discord (commands.openInviteDialog). Quem é convidado é
 * escolhido pelo usuário nessa tela; a Activity não recebe nenhum dado de contatos.
 */
export async function openInviteDialog({ sdkReady }: { sdkReady: boolean }): Promise<InviteResult> {
  if (!sdkReady) return 'unavailable';
  const commands = getDiscordSdk().commands as { openInviteDialog?: () => Promise<unknown> };
  if (typeof commands.openInviteDialog !== 'function') return 'unsupported';
  try {
    await commands.openInviteDialog();
    return 'opened';
  } catch (error) {
    // Só o código/tipo do erro (nunca dados do usuário).
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : error instanceof Error ? error.name : 'unknown';
    console.warn(`[participants] openInviteDialog falhou (${code}).`);
    return 'failed';
  }
}
