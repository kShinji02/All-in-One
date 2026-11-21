import { getDiscordSdk } from '@/discord/sdk';

/**
 * Resultado de pedir ao Discord para abrir um link externo.
 * - opened: o Discord abriu (o usuário confirmou no modal, ou o domínio é confiável).
 * - declined: o Discord informou que não abriu (ex.: o usuário cancelou o modal).
 * - unknown: clientes antigos (antes de dez/2024) respondem { opened: null }.
 * - unavailable: o SDK ainda não concluiu o handshake; nada é aberto.
 * - failed: o comando falhou.
 */
export type ExternalLinkResult = 'opened' | 'declined' | 'unknown' | 'unavailable' | 'failed';

/**
 * Único caminho para abrir links externos dentro do Discord: commands.openExternalLink.
 * A Activity roda num iframe isolado; o Discord decide e mostra a própria confirmação
 * ("sair do Discord"), que só é pulada para domínios que o usuário marcou como confiáveis.
 *
 * Nunca usa window.open nem navegação nativa como alternativa: isso abriria o
 * navegador sem a confirmação do Discord.
 */
export async function openExternalLink(url: string, { sdkReady }: { sdkReady: boolean }): Promise<ExternalLinkResult> {
  if (!sdkReady) return 'unavailable';
  try {
    const { opened } = await getDiscordSdk().commands.openExternalLink({ url });
    return opened === null ? 'unknown' : opened ? 'opened' : 'declined';
  } catch (error) {
    // Registra só o código/tipo do erro: a URL é conteúdo de mensagem e não vai para o log.
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : error instanceof Error ? error.name : 'unknown';
    console.warn(`[chat] openExternalLink falhou (${code}).`);
    return 'failed';
  }
}
