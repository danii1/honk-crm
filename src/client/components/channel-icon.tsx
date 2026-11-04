import {
  AtSign,
  Briefcase,
  Camera,
  Cloud,
  Code,
  Gamepad2,
  Globe,
  Hash,
  Link2,
  Mail,
  MessageCircle,
  Phone,
  Play,
  Send,
  ThumbsUp,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/client/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  x: X,
  linkedin: Briefcase,
  reddit: MessageCircle,
  email: Mail,
  threads: AtSign,
  hackernews: Hash,
  github: Code,
  discord: Gamepad2,
  slack_community: Hash,
  bluesky: Cloud,
  tiktok: Play,
  instagram: Camera,
  youtube: Play,
  facebook: ThumbsUp,
  telegram: Send,
  whatsapp: Phone,
  website: Globe,
  other: Link2,
};

export function ChannelIcon({ channel, className }: { channel: string; className?: string }) {
  const Icon = ICONS[channel] ?? Globe;
  return <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", className)} />;
}
