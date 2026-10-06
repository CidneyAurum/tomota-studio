import {
  Children, createContext, isValidElement, type AnchorHTMLAttributes, type MouseEvent, type ReactElement,
  type ReactNode, useCallback, useContext, useEffect, useMemo, useState,
} from "react";

export interface RouterLocation { pathname: string; search: string }
type Params = Record<string, string>;
type NavigateOptions = {replace?: boolean};
type Navigate = (to: string, options?: NavigateOptions) => void;

const LocationContext = createContext<{location: RouterLocation; navigate: Navigate} | null>(null);
const MatchContext = createContext<{params: Params; outlet: ReactNode}>({params: {}, outlet: null});
const OutletContext = createContext<unknown>(undefined);

function currentLocation(): RouterLocation { return {pathname: window.location.pathname || "/", search: window.location.search || ""}; }

export function BrowserRouter({children}: {children: ReactNode}) {
  const [location, setLocation] = useState<RouterLocation>(currentLocation);
  const update = useCallback(() => setLocation((previous) => {
    const next = currentLocation();
    return previous.pathname === next.pathname && previous.search === next.search ? previous : next;
  }), []);
  useEffect(() => {
    window.addEventListener("popstate", update);
    window.addEventListener("tomota:navigate", update);
    return () => { window.removeEventListener("popstate", update); window.removeEventListener("tomota:navigate", update); };
  }, [update]);
  const navigate: Navigate = useCallback((to, options) => {
    const target = new URL(to, window.location.href);
    if (options?.replace) window.history.replaceState(null, "", `${target.pathname}${target.search}${target.hash}`);
    else window.history.pushState(null, "", `${target.pathname}${target.search}${target.hash}`);
    update();
    window.dispatchEvent(new Event("tomota:navigate"));
  }, [update]);
  return <LocationContext.Provider value={{location, navigate}}>{children}</LocationContext.Provider>;
}

function useRouter() {
  const value = useContext(LocationContext);
  if (!value) throw new Error("Router hooks must be used inside BrowserRouter");
  return value;
}

export function useLocation() { return useRouter().location; }
export function useNavigate() { return useRouter().navigate; }

function normalize(value: string) {
  const path = value.split("?")[0].replace(/\/+$/, "") || "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function match(pattern: string, pathname: string, end = true): {params: Params} | null {
  const patternParts = normalize(pattern).split("/").filter(Boolean);
  const pathParts = normalize(pathname).split("/").filter(Boolean);
  const params: Params = {};
  let index = 0;
  for (; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    if (expected === "*") return {params};
    const actual = pathParts[index];
    if (actual === undefined) return null;
    if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return null;
  }
  if (end && index !== pathParts.length) return null;
  return {params};
}

export function matchPath(pattern: string, pathname: string) { return match(pattern, pathname, !pattern.endsWith("/*")); }

interface RouteProps {path?: string; index?: boolean; element: ReactNode; children?: ReactNode}
export function Route(_props: RouteProps) { return null; }

function joinPath(base: string, child: string) {
  if (child.startsWith("/")) return normalize(child);
  return normalize(`${normalize(base)}/${child}`);
}

function renderRouteTree(children: ReactNode, pathname: string, base = "", inherited: Params = {}): ReactNode {
  for (const node of Children.toArray(children)) {
    if (!isValidElement<RouteProps>(node) || node.type !== Route) continue;
    const props = node.props;
    if (props.index) {
      if (!match(base, pathname, true)) continue;
      return <MatchContext.Provider value={{params: inherited, outlet: null}}>{props.element}</MatchContext.Provider>;
    }
    const full = joinPath(base, props.path || "");
    const nested = Boolean(props.children);
    const found = match(full, pathname, !nested && !full.endsWith("/*"));
    if (!found) continue;
    const params = {...inherited, ...found.params};
    const child = nested ? renderRouteTree(props.children, pathname, full, params) : null;
    if (nested && !child && !match(full, pathname, true)) continue;
    return <MatchContext.Provider value={{params, outlet: child}}>{props.element}</MatchContext.Provider>;
  }
  return null;
}

export function Routes({children}: {children: ReactNode}) {
  const {location} = useRouter();
  return <>{renderRouteTree(children, location.pathname)}</>;
}

export function Outlet({context}: {context?: unknown}) {
  const {outlet} = useContext(MatchContext);
  return <OutletContext.Provider value={context}>{outlet}</OutletContext.Provider>;
}

export function useOutletContext<T>() { return useContext(OutletContext) as T; }
export function useParams<T extends Params = Params>() { return useContext(MatchContext).params as T; }

export function useSearchParams(): [URLSearchParams, (next: URLSearchParams | Record<string, string>) => void] {
  const {location, navigate} = useRouter();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const set = (next: URLSearchParams | Record<string, string>) => {
    const value = next instanceof URLSearchParams ? next : new URLSearchParams(next);
    navigate(`${location.pathname}${value.size ? `?${value.toString()}` : ""}`);
  };
  return [params, set];
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {to: string}
export function Link({to, onClick, ...props}: LinkProps) {
  const navigate = useNavigate();
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(to);
  };
  return <a {...props} href={to} onClick={click}/>;
}

export function NavLink({to, end = false, className = "", ...props}: LinkProps & {end?: boolean}) {
  const {location} = useRouter();
  const active = end ? normalize(location.pathname) === normalize(to) : normalize(location.pathname).startsWith(normalize(to));
  return <Link {...props} to={to} className={`${className} ${active ? "active" : ""}`.trim()}/>;
}

export function Navigate({to, replace = false}: {to: string; replace?: boolean}) {
  const navigate = useNavigate();
  useEffect(() => navigate(to, {replace}), [navigate, replace, to]);
  return null;
}
