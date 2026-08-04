import { LayoutDashboard, Brain, Calculator, History, Trophy, ClipboardList, ClipboardCheck, RadioTower, Snowflake, Heart } from "lucide-react";
import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { useAuth } from "@/lib/auth-context";

const navItems = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "NBA Predictor", url: "/predictor", icon: Brain },
  { title: "MLB Predictor", url: "/mlb", icon: Trophy },
  { title: "WNBA Predictor", url: "/wnba", icon: Heart },
  { title: "NHL Predictor", url: "/nhl", icon: Snowflake },
  { title: "Calculadora", url: "/calculator", icon: Calculator },
  { title: "Historial NBA", url: "/history", icon: History },
  { title: "MLB En Foco", url: "/mlb-history", icon: ClipboardList },
  { title: "Historial WNBA", url: "/wnba-history", icon: ClipboardList },
  { title: "Historial NHL", url: "/nhl-history", icon: ClipboardList },
];

const privateNavItems = [
  { title: "Operaciones", url: "/operations", icon: RadioTower },
  { title: "Revisión MLB", url: "/mlb-human-review", icon: ClipboardCheck },
];

function CourtEdgeLogo() {
  return (
    <svg
      viewBox="0 0 180 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="h-8 w-auto"
      aria-label="CourtEdge Logo"
    >
      {/* Basketball icon */}
      <circle cx="20" cy="20" r="14" stroke="hsl(217 91% 60%)" strokeWidth="2.5" fill="none" />
      <path d="M6 20 h28" stroke="hsl(217 91% 60%)" strokeWidth="1.5" />
      <path d="M20 6 v28" stroke="hsl(217 91% 60%)" strokeWidth="1.5" />
      <path d="M8.5 10 C14 14, 14 26, 8.5 30" stroke="hsl(217 91% 60%)" strokeWidth="1.5" fill="none" />
      <path d="M31.5 10 C26 14, 26 26, 31.5 30" stroke="hsl(217 91% 60%)" strokeWidth="1.5" fill="none" />
      {/* Text */}
      <text x="42" y="17" fontFamily="var(--font-display)" fontWeight="700" fontSize="14" fill="hsl(210 40% 93%)">Court</text>
      <text x="84" y="17" fontFamily="var(--font-display)" fontWeight="700" fontSize="14" fill="hsl(217 91% 60%)">Edge</text>
      <text x="42" y="32" fontFamily="var(--font-sans)" fontWeight="400" fontSize="8.5" fill="hsl(215 20% 55%)" letterSpacing="0.12em">SPORTS BETTING PREDICTOR</text>
    </svg>
  );
}

export function AppSidebar() {
  const [location] = useLocation();
  const { authenticated } = useAuth();
  const visibleItems = authenticated ? [...navItems, ...privateNavItems] : navItems;

  return (
    <Sidebar>
      <SidebarHeader className="p-4 pb-2">
        <CourtEdgeLogo />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {visibleItems.map((item) => {
                const isActive = location === item.url;
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      data-testid={`nav-${item.url.replace("/", "") || "dashboard"}`}
                    >
                      <Link href={item.url}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4 pt-2">
        <p className="text-xs text-muted-foreground">v1.0 — Sin servidor</p>
      </SidebarFooter>
    </Sidebar>
  );
}
