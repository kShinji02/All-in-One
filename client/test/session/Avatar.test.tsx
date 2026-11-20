import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar } from '@/features/session/components/Avatar';

const URL_A = 'https://cdn.discordapp.com/avatars/1/a.png?size=128';
const URL_B = 'https://cdn.discordapp.com/avatars/1/b.png?size=128';

describe('Avatar (Fases 2 e 3)', () => {
  it('com URL, renderiza a imagem decorativa (alt vazio)', () => {
    const { container } = render(<Avatar src={URL_A} label="Ana" />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', URL_A);
    expect(img).toHaveAttribute('alt', '');
  });

  it('sem URL, mostra a inicial em maiúscula, oculta de leitores de tela', () => {
    const { container } = render(<Avatar src={null} label="bruno" />);
    expect(container.querySelector('img')).toBeNull();
    const fallback = container.firstElementChild;
    expect(fallback).toHaveTextContent('B');
    expect(fallback).toHaveAttribute('aria-hidden', 'true');
  });

  it('rótulo vazio usa "?"', () => {
    const { container } = render(<Avatar src={null} label="   " />);
    expect(container.firstElementChild).toHaveTextContent('?');
  });

  it('falha ao carregar a imagem troca pela inicial', () => {
    const { container } = render(<Avatar src={URL_A} label="Ana" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.firstElementChild).toHaveTextContent('A');
  });

  it('URL nova após uma falha é tentada (correção da auditoria da Fase 3)', () => {
    const { container, rerender } = render(<Avatar src={URL_A} label="Ana" />);
    fireEvent.error(container.querySelector('img')!);
    rerender(<Avatar src={URL_B} label="Ana" />);
    expect(container.querySelector('img')).toHaveAttribute('src', URL_B);
  });

  it('a mesma URL que falhou continua com a inicial', () => {
    const { container, rerender } = render(<Avatar src={URL_A} label="Ana" />);
    fireEvent.error(container.querySelector('img')!);
    rerender(<Avatar src={URL_A} label="Ana" />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('formato circular por padrão e arredondado quando pedido', () => {
    const { container, rerender } = render(<Avatar src={URL_A} label="Ana" />);
    expect(container.querySelector('img')).toHaveClass('rounded-full');
    rerender(<Avatar src={URL_A} label="Ana" shape="rounded" />);
    expect(container.querySelector('img')).toHaveClass('rounded-xl');
  });
});
