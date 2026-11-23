import { RPCCloseCodes } from '@discord/embedded-app-sdk';
import { getDiscordSdk } from '@/discord/sdk';

/**
 * Fecha a Activity pelo SDK (o Discord encerra o iframe). Devolve false se não foi
 * possível; nesse caso a tela continua bloqueada e o usuário pode fechar pelo Discord.
 */
export function exitActivity(): boolean {
  try {
    getDiscordSdk().close(RPCCloseCodes.CLOSE_NORMAL, 'Termos de Uso não aceitos');
    return true;
  } catch {
    return false;
  }
}
