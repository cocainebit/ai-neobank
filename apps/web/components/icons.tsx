import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export const Icons = {
  Logo: (props: IconProps) => <Icon {...props} strokeWidth={2.2}><path d="M5 19V5h8a4 4 0 0 1 0 8H5m7 0 6 6" /></Icon>,
  Overview: (props: IconProps) => <Icon {...props}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></Icon>,
  Payments: (props: IconProps) => <Icon {...props}><path d="M7 17 17 7M9 7h8v8" /></Icon>,
  Treasury: (props: IconProps) => <Icon {...props}><rect x="3" y="5" width="18" height="15" rx="2" /><circle cx="14" cy="12.5" r="2.5" /><path d="M7 9v7M3 9h2M3 16h2" /></Icon>,
  Vault: (props: IconProps) => <Icon {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="12" cy="11" r="2.5" /><path d="M12 13.5V16M7 4v16M17 4v16" /></Icon>,
  Card: (props: IconProps) => <Icon {...props}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h3" /></Icon>,
  Lock: (props: IconProps) => <Icon {...props}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></Icon>,
  Invoice: (props: IconProps) => <Icon {...props}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6M9 16h3" /></Icon>,
  Recurring: (props: IconProps) => <Icon {...props}><path d="M17 2l3 3-3 3" /><path d="M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3" /><path d="M20 13v2a4 4 0 0 1-4 4H4" /></Icon>,
  Statement: (props: IconProps) => <Icon {...props}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></Icon>,
  Agent: (props: IconProps) => <Icon {...props}><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4M9 13v1M15 13v1M2 13v2M22 13v2" /></Icon>,
  Policy: (props: IconProps) => <Icon {...props}><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z" /><path d="m9 12 2 2 4-4" /></Icon>,
  Beneficiary: (props: IconProps) => <Icon {...props}><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0M16 11l2 2 4-4" /></Icon>,
  Members: (props: IconProps) => <Icon {...props}><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3" /></Icon>,
  Code: (props: IconProps) => <Icon {...props}><path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" /></Icon>,
  Settings: (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Icon>,
  Plus: (props: IconProps) => <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>,
  Check: (props: IconProps) => <Icon {...props}><path d="m5 12 5 5 9-10" /></Icon>,
  Close: (props: IconProps) => <Icon {...props}><path d="M6 6l12 12M18 6 6 18" /></Icon>,
  Copy: (props: IconProps) => <Icon {...props}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></Icon>,
  External: (props: IconProps) => <Icon {...props}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Icon>,
  Chevrons: (props: IconProps) => <Icon {...props}><path d="m8 9 4-4 4 4M16 15l-4 4-4-4" /></Icon>,
  ChevronRight: (props: IconProps) => <Icon {...props}><path d="m9 6 6 6-6 6" /></Icon>,
  Logout: (props: IconProps) => <Icon {...props}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11" /></Icon>,
  Alert: (props: IconProps) => <Icon {...props}><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17h.01" /></Icon>,
  Info: (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Icon>,
  Wallet: (props: IconProps) => <Icon {...props}><path d="M4 7a2 2 0 0 1 2-2h12v4" /><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M16 13.5h2" /></Icon>,
  Refresh: (props: IconProps) => <Icon {...props}><path d="M20 11a8 8 0 0 0-14.8-3.5M4 4v4h4M4 13a8 8 0 0 0 14.8 3.5M20 20v-4h-4" /></Icon>,
  Freeze: (props: IconProps) => <Icon {...props}><path d="M12 2v20M4.9 6l14.2 12M19.1 6 4.9 18M9 4l3 2 3-2M9 20l3-2 3 2" /></Icon>,
  Key: (props: IconProps) => <Icon {...props}><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M14 9l2 2" /></Icon>,
  Download: (props: IconProps) => <Icon {...props}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></Icon>,
  In: (props: IconProps) => <Icon {...props}><path d="M17 7 7 17M15 17H7V9" /></Icon>,
  Out: (props: IconProps) => <Icon {...props}><path d="M7 17 17 7M9 7h8v8" /></Icon>,
  Clock: (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>,
  Ethereum: (props: IconProps) => <Icon {...props}><path d="m12 2 7 10-7 4-7-4z" /><path d="m5 13.5 7 8.5 7-8.5-7 4z" /></Icon>,
  Solana: (props: IconProps) => <Icon {...props}><path d="M6 6h14l-2 3H4zM4 10.5h14l2 3H6zM6 15h14l-2 3H4z" /></Icon>,
  Menu: (props: IconProps) => <Icon {...props}><path d="M4 7h16M4 12h16M4 17h16" /></Icon>,
  Link: (props: IconProps) => <Icon {...props}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></Icon>
};
