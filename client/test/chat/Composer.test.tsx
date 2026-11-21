import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '@/features/chat/components/Composer';
import type { ChatSendResult } from '@/realtime/useChat';

const ok = (): ChatSendResult => ({ ok: true, key: 'l:n', nonce: 'n' });

function setup(onSend = vi.fn(ok), disabledReason: string | null = null) {
  render(<Composer onSend={onSend} disabledReason={disabledReason} />);
  const input = screen.getByRole('textbox', { name: 'Mensagem' });
  const button = screen.getByRole('button', { name: 'Enviar mensagem' });
  return { onSend, input: input as HTMLTextAreaElement, button };
}

describe('Composer', () => {
  it('campo e botão têm nomes acessíveis; o formulário também', () => {
    setup();
    expect(screen.getByRole('form', { name: 'Enviar mensagem' })).toBeInTheDocument();
    expect(screen.getByLabelText('Mensagem')).toBeInTheDocument();
  });

  it('Enter envia e limpa o campo', async () => {
    const { onSend, input } = setup();
    await userEvent.type(input, 'olá{Enter}');
    expect(onSend).toHaveBeenCalledExactlyOnceWith('olá');
    expect(input.value).toBe('');
    expect(input).toHaveFocus();
  });

  it('Shift+Enter quebra linha sem enviar', async () => {
    const { onSend, input } = setup();
    await userEvent.type(input, 'linha 1{Shift>}{Enter}{/Shift}linha 2');
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('linha 1\nlinha 2');
    await userEvent.type(input, '{Enter}');
    expect(onSend).toHaveBeenCalledWith('linha 1\nlinha 2');
  });

  it('Enter durante composição de IME não envia', () => {
    const { onSend, input } = setup();
    fireEvent.change(input, { target: { value: 'ã' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('envio pelo botão', async () => {
    const { onSend, input, button } = setup();
    await userEvent.type(input, 'pelo botão');
    await userEvent.click(button);
    expect(onSend).toHaveBeenCalledExactlyOnceWith('pelo botão');
  });

  it('texto vazio ou só espaços: botão desabilitado e Enter não envia', async () => {
    const { onSend, input, button } = setup();
    expect(button).toBeDisabled();
    await userEvent.type(input, '   {Enter}');
    expect(button).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Enter e clique simultâneos enviam uma única vez', () => {
    const { onSend, input, button } = setup();
    fireEvent.change(input, { target: { value: 'uma vez' } });
    // Mesmo tique: o clique chega antes de o React re-renderizar com o campo vazio.
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.submit(button.closest('form')!);
    fireEvent.click(button);
    expect(onSend).toHaveBeenCalledExactlyOnceWith('uma vez');
  });

  it('limite de 500 code points: corta o excesso e avisa', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '😀'.repeat(501) } });
    expect([...input.value]).toHaveLength(500);
    expect(screen.getByText('Limite de 500 caracteres atingido.')).toBeInTheDocument();
    expect(screen.getByLabelText('0 caracteres restantes')).toHaveTextContent('500/500');
  });

  it('o contador só aparece perto do limite', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'a'.repeat(449) } });
    expect(screen.queryByLabelText(/caracteres restantes/)).toBeNull();
    fireEvent.change(input, { target: { value: 'a'.repeat(450) } });
    expect(screen.getByLabelText('50 caracteres restantes')).toBeInTheDocument();
  });

  it('recusa local preserva o texto e mostra o motivo', async () => {
    const onSend = vi.fn((): ChatSendResult => ({ ok: false, reason: 'too_many_pending' }));
    const { input } = setup(onSend);
    await userEvent.type(input, 'guardado{Enter}');
    expect(input.value).toBe('guardado');
    expect(screen.getByText(/mensagens demais aguardando envio/)).toBeInTheDocument();
  });

  it('desabilitado com texto já digitado (ex.: sessão expirou): Enter e envio do formulário não enviam', () => {
    const onSend = vi.fn(ok);
    const { rerender } = render(<Composer onSend={onSend} disabledReason={null} />);
    const field = screen.getByRole('textbox', { name: 'Mensagem' });
    fireEvent.change(field, { target: { value: 'digitado antes' } });
    rerender(<Composer onSend={onSend} disabledReason="Sessão expirada." />);
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.submit(field.closest('form')!);
    expect(onSend).not.toHaveBeenCalled();
    expect(field).toHaveValue('digitado antes'); // o texto não se perde
  });

  it('desabilitado mostra o motivo e não envia', async () => {
    const { onSend, input, button } = setup(vi.fn(ok), 'O chat abre quando a Activity estiver autenticada no Discord.');
    expect(input).toBeDisabled();
    expect(button).toBeDisabled();
    expect(screen.getByText(/O chat abre quando/)).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });
});
