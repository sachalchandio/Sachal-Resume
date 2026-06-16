import { useCallback, useState } from "react";
import { Routes, Route } from "react-router-dom";
import Portfolio from "./pages/Portfolio";
import OffDuty from "./pages/OffDuty";
import Projects from "./pages/Projects";
import NotFound from "./pages/NotFound";
import CommandPalette from "./components/CommandPalette";
import { useKonami } from "./hooks/useKonami";

export default function App() {
  const [egg, setEgg] = useState(false);

  const fireEgg = useCallback(() => {
    setEgg(true);
    window.dispatchEvent(new Event("konami")); // the 3D core reacts to this
    window.setTimeout(() => setEgg(false), 3400);
  }, []);
  useKonami(fireEgg);

  return (
    <>
      <Routes>
        <Route path="/" element={<Portfolio />} />
        <Route path="/off-duty" element={<OffDuty />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="*" element={<NotFound />} />
      </Routes>

      <CommandPalette />

      {egg && (
        <div className="egg-toast" role="status">
          <span className="egg-emoji">🎮</span>
          Konami code — I see you. The core remembers.
        </div>
      )}
    </>
  );
}
