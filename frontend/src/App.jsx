import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import WhatsApp from './pages/WhatsApp';
import JDDetail from './pages/JDDetail';
import CandidateDetail from './pages/CandidateDetail';
// The manual side. Separate routes and separate pages from the WhatsApp
// screens above, because the data behind them is separate too.
import TalentPool from './pages/TalentPool';
import TalentDetail from './pages/TalentDetail';
import ManualRoles from './pages/ManualRoles';
import ManualRoleDetail from './pages/ManualRoleDetail';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />

        {/* The WhatsApp side is one destination with three tabs. The detail
            pages stay on their own paths — a single candidate is not a tab. */}
        <Route path="/whatsapp" element={<WhatsApp />} />
        <Route path="/jds/:id" element={<JDDetail />} />
        <Route path="/candidates/:id" element={<CandidateDetail />} />

        {/* The old list paths still resolve. Links to them exist in bookmarks
            and in the detail pages' own "back" navigation, and a dead route
            would strand both. */}
        <Route path="/jds" element={<Navigate to="/whatsapp?tab=messages" replace />} />
        <Route path="/candidates" element={<Navigate to="/whatsapp?tab=applicants" replace />} />
        <Route path="/review" element={<Navigate to="/whatsapp?tab=review" replace />} />

        <Route path="/talent" element={<TalentPool />} />
        <Route path="/talent/:id" element={<TalentDetail />} />
        <Route path="/roles" element={<ManualRoles />} />
        <Route path="/roles/:id" element={<ManualRoleDetail />} />
      </Routes>
    </Layout>
  );
}
