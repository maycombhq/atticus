import { Route, Routes } from "react-router-dom";
import { Limits } from "./Limits";

export function App() {
  return (
    <Routes>
      <Route path="/limits" element={<Limits />} />
    </Routes>
  );
}
