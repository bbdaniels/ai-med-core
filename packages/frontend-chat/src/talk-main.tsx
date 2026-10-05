// Entry for a talk build (VITE_APP=talk; see vite.config.ts): the admin route
// or the talk page. main.tsx is the simulator's entry.
import React from 'react'
import ReactDOM from 'react-dom/client'
import TalkApp from './talk/TalkApp.tsx'
import { ADMIN_PATH, AdminRoute, useAppPath } from './admin-route.tsx'
import './App.css'
import '../style.css'

function TalkRoot() {
  return useAppPath() === ADMIN_PATH ? <AdminRoute /> : <TalkApp />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TalkRoot />
  </React.StrictMode>,
)
