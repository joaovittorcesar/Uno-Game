# UNO ARENA

Jogo de cartas multiplayer em tempo real, feito com React, TypeScript, Vite, Node.js e Socket.IO. O servidor controla as mãos, os turnos, as penalidades e os resultados; cada navegador recebe apenas a própria mão.

## Rodar no computador anfitrião

Requisitos: Node.js 20 ou superior e npm.

```powershell
npm install
npm run dev
```

Abra `http://localhost:5173/uno/`. Para jogar em outros dispositivos da mesma rede, use o botão **Copiar convite** no lobby (ele troca `localhost` pelo IP local detectado). Se necessário, descubra o IP do computador anfitrião com `ipconfig` e permita Node.js na Firewall do Windows.

Para publicar a versão de produção na mesma máquina:

```powershell
npm run build
npm start
```

Nesse modo, os jogadores acessam `http://IP-DO-COMPUTADOR:25574/uno/`. O processo escuta em todas as interfaces de rede. Para acesso pela internet, encaminhe a porta no roteador e configure HTTPS/reverse proxy; não exponha uma máquina pessoal à internet sem entender as implicações de segurança.

## Hospedar no Pterodactyl

Use uma egg de Node.js, mantenha `index.js` como arquivo de entrada e configure o comando de inicialização como `npm start`. O script compila a interface para `dist` e inicia o servidor com Socket.IO; assim, o site e o jogo usam a mesma porta. O domínio/reverse proxy precisa encaminhar `/uno/` e as requisições HTTP de `/uno/socket.io` para a porta alocada.

No painel, aloque a porta `25574` ao servidor. O aplicativo usa `SERVER_PORT` ou `PORT` fornecida pelo ambiente e, se nenhuma estiver definida, usa `25574`. A porta precisa estar alocada/liberada no painel para que os jogadores consigam acessar o endereço público. Instale as dependências com `npm install --include=dev` antes da primeira inicialização, pois o script de inicialização compila a aplicação antes de servir o site.

## Comandos

- `npm run dev`: inicia a interface e o servidor multiplayer para desenvolvimento.
- `npm run build`: valida os tipos do cliente e servidor e gera `dist`.
- `npm start`: gera o build de produção e inicia o servidor pelo `index.js`.
- `npm test`: executa os testes das regras do jogo.

Configuração opcional do servidor:

- `SERVER_PORT` ou `PORT`: porta HTTP/Socket.IO (padrão `25574`).
- Caminho Socket.IO: `/uno/socket.io`.
- `ALLOWED_ORIGIN`: origens permitidas separadas por vírgula. Se não definida, o servidor aceita conexões de qualquer origem para simplificar partidas em LAN.

## Recursos implementados

- Criação de salas públicas e privadas protegidas por senha com hash scrypt.
- Código/link de convite, lista de salas públicas e partida rápida.
- Lobby com anfitrião, jogadores conectados, estado de pronto e início validado.
- Partida solo contra adversários de IA, com quantidade total de jogadores configurável entre 2 e 10.
- Baralho de 108 cartas, números, pular, inverter, +2, curingas e +4.
- Validação autoritativa de jogadas, turno, cor, penalidades, UNO e vitória.
- Variante opcional de acumular cartas de compra.
- Compra, passagem quando permitida, temporizador, reconexão e limpeza de salas.
- Chat com limite de tamanho e frequência.
- Layout responsivo, apelido e avatar salvos no navegador.

## Limites desta versão

As salas e partidas ficam em memória e são encerradas quando o servidor reinicia. Não há contas, banco de dados, estatísticas persistentes, ranking, administração, espectadores, denúncias ou histórico entre partidas. O perfil é local ao navegador, não uma conta autenticada. Esses recursos não são simulados.
