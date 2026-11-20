/**
 * Recarrega a página da Activity. A URL (com frame_id, instance_id e platform)
 * é preservada, então uma nova instância do SDK é criada e envia um novo handshake.
 * Isolado em um módulo para poder ser substituído nos testes.
 */
export function reloadPage(): void {
  window.location.reload();
}
