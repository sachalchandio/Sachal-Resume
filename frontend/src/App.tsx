import { Routes, Route } from "react-router-dom";
import Portfolio from "./pages/Portfolio";
import OffDuty from "./pages/OffDuty";
import NotFound from "./pages/NotFound";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Portfolio />} />
      <Route path="/off-duty" element={<OffDuty />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
