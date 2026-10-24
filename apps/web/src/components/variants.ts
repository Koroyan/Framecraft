import { cva } from 'class-variance-authority';

/** Pure style helpers — safe to call from Server Components. */
export const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-all duration-200 disabled:pointer-events-none disabled:opacity-45 active:scale-[0.98] [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-iris-500 text-white shadow-[0_8px_30px_-10px_rgb(124_108_255/0.8)] hover:bg-iris-400',
        secondary: 'surface text-fog-100 hover:bg-white/[0.06]',
        ghost: 'text-fog-200 hover:bg-white/[0.05] hover:text-white',
        outline: 'border hairline text-fog-100 hover:bg-white/[0.04]',
        danger: 'bg-signal-red/15 text-signal-red hover:bg-signal-red/25',
        white: 'bg-white text-ink-950 hover:bg-fog-100',
      },
      size: { sm: 'h-8 px-3 text-[13px]', md: 'h-10 px-4', lg: 'h-12 px-6 text-[15px]', xl: 'h-14 px-8 text-base rounded-2xl', icon: 'size-9 p-0' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);
