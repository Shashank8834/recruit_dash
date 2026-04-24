import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import JDList from './pages/JDList';
import JDDetail from './pages/JDDetail';
import CandidateList from './pages/CandidateList';
import CandidateDetail from './pages/CandidateDetail';

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
      </Routes>
    </Layout>
  );
}
