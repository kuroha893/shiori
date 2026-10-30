import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './lib/fonts'
import './styles/base.css'
import './styles/library.css'
import './styles/reader.css'
import { App } from './components/App'

createRoot(document.getElementById('root')!).render(<App />)
