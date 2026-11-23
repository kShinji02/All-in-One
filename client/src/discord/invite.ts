import { getDiscordSdk } from '@/discord/sdk';

/**
 * Resultado de pedir ao Discord para abrir o convite da Activity.
 * - opened: o Discord aceitou o comando (o próprio Discord mostra a tela de convite).
 * - unavailable: o SDK ainda não concluiu a conexão; nada é feito.
 * - failed: o Discord recusou ou não suporta o comando neste dispositivo.
 */
export type InviteResult = 'opened' | 'unavailable' | 'failed';

/**
 * Abre a tela de convite do PRÓPRIO Discord (commands.openInviteDialog). Quem envia o convite
 * e para quem é decidido pelo usuário nessa tela; a Activity não recebe nenhum dado de contatos.
 */
export async function openInviteDialog({ sdkReady }: { sdkReady: boolean }): Promise<InviteResult> {
  if (!sdkReady) return 'unavailable';
  try {
    await getDiscordSdk().commands.openInviteDialog();
    return 'opened';
  } catch (error) {
    // Só o código/tipo do erro.
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : error instanceof Error ? error.name : 'unknown';
    console.warn(`[participants] openInviteDialog falhou (${code}).`);
    return 'failed';
  }
}
