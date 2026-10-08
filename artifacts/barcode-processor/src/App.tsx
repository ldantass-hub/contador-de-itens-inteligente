import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Login from "@/pages/login";
import Admin from "@/pages/admin";
import UserManagement from "@/pages/user-management";
import { AuthProvider, useAuth } from "@/lib/authContext";

const queryClient = new QueryClient();

function ProtectedRoute({ component: Component, adminOnly = false }: {
  component: React.ComponentType;
  adminOnly?: boolean;
}) {
  const { user, isAdmin } = useAuth();
  const [location] = useLocation();

  if (!user) return <Redirect to="/login" />;
  if (user.mustChangePassword) return location === "/" ? <Component /> : <Redirect to="/" />;
  if (adminOnly && !isAdmin) return <Redirect to="/" />;
  return <Component />;
}

function Router() {
  const { user, authReady } = useAuth();
  if (!authReady) return null;
  return (
    <Switch>
      <Route path="/login">
        {user ? <Redirect to="/" /> : <Login />}
      </Route>
      <Route path="/admin/users">
        <ProtectedRoute component={UserManagement} adminOnly />
      </Route>
      <Route path="/admin">
        <ProtectedRoute component={Admin} adminOnly />
      </Route>
      <Route path="/">
        <ProtectedRoute component={Home} />
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
