import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import JDList from './pages/JDList';
import JDDetail from './pages/JDDetail';
import CandidateList from './pages/CandidateList';
import CandidateDetail from './pages/CandidateDetail';
import Review from './pages/Review';
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
        <Route path="/jds" element={<JDList />} />
        <Route path="/jds/:id" element={<JDDetail />} />
        <Route path="/candidates" element={<CandidateList />} />
        <Route path="/candidates/:id" element={<CandidateDetail />} />
        <Route path="/review" element={<Review />} />

        <Route path="/talent" element={<TalentPool />} />
        <Route path="/talent/:id" element={<TalentDetail />} />
        <Route path="/roles" element={<ManualRoles />} />
        <Route path="/roles/:id" element={<ManualRoleDetail />} />
      </Routes>
    </Layout>
  );
}
