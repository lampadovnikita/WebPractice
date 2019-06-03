const dgram = require('dgram');
const readline = require('readline');

const hashManager = require('./HashManager');
const dataManager = require('./DataManager');
const messageHandler = require('./MessageHandler');
const netInterfaceHandler = require('./NetworkInterfaceHandler');

const PORT = 41234;
const BROADCAST_ADDRESS = netInterfaceHandler.getBroadcastAddress();

const CONNECTION_TIME = 3000; // Время подключения(первого сбора информации), мс
const CHECK_INTERVAL = 15000; // Интервал повторений опроса, мс

// Для считывания текста с консоли
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Массив с информацией о всех online пользователях
// Каждый элемент представлен следующей структурой: ID, Name
// Как в этом языке делать массив структуры??????????????????????????
let prevOnlineUsers = {
  users: []
};

let currentOnlineUsers = {
  users: []
};

let currentUserName;
let currentUserID;

// Файлы, хеш которых нужно отослать
let filesToSend = undefined;

// Информация, котрую запрашиваем у остальных пользователей
let searchInfo = undefined;

// Флаг, показывающий, что пользователь подключен (информация об online пользователях собирается первый раз)
let isConnected = false;

const dgramSocket = dgram.createSocket("udp4");

// Когда сокет начал слушать
dgramSocket.on('listening', function () {
  let serverAddress = dgramSocket.address();
  console.log('Listening UDP on ' + serverAddress.address + ":" + serverAddress.port);
});

// Когда на сокет пришло сообщение
dgramSocket.on('message', function (message, rinfo) {
  // Если пользователь не ввёл имя, то считаем его неподключенным и игнорируем входящие сообщения
  if (currentUserName === undefined) {
    return;
  }

  // Получаем данные о сообщении из обработчика
  let messageData = messageHandler.processMessage(message);

  // Если пришёл запрос на проверку активности
  if (messageData['Type'] === messageHandler.MSG_REQUEST_ONLINE_CODE) {
    // Формируем и отправляем ответ
    let responseMessage = messageHandler.buildResponseIsOnline(currentUserID, currentUserName);
    dgramSocket.send(responseMessage, 0, responseMessage.length, PORT, rinfo.address);
  }
  // Если пришёл ответ об активности
  else if (messageData['Type'] === messageHandler.MSG_RESPONSE_ONLINE_CODE) {
    // Добавляем информацию о пользователе в массив
    currentOnlineUsers.users.push({
      ID: messageData['SenderID'],
      Name: messageData['SenderName'],
    });
  }
  // Если пришёл запрос на хранение ссылки на файл
  else if (messageData['Type'] === messageHandler.MSG_REQUEST_FILE_LINK_HOLDING_CODE) {
    // Если сообщение пришло самому себе, игнорируем
    if (messageData['SenderID'] === currentUserID) {
      return;
    }

    // Если запрос адресован нам
    if (currentUserID === messageData['DestinationID']) {
      console.log('-------------------------------------------------------------');
      console.log('Request for saving file link');
      console.log('Sender ID: ' + messageData['SenderID']);
      console.log('Destination ID: ' + messageData['DestinationID']);
      console.log('File ID: ' + messageData['FileID']);

      let hashes = [];
      hashes.push(messageData['FileID']);
      hashes.push(messageData['FileNameID']);
      hashes.push(messageData['FirstNameID']);
      hashes.push(messageData['LastNameID']);

      // Записываем ссылку на файл
      dataManager.writeFileLink(hashes, messageData['SenderID']);

      console.log('Link saved');
      console.log('-------------------------------------------------------------');

      // Создаём сообщение для подтверждения сохранения
      let responseMessage = messageHandler.buildSaveFileLinkResponse(currentUserID, messageData['FileID'],
        messageData['SenderID']);

      dgramSocket.send(responseMessage, 0, responseMessage.length, PORT, rinfo.address);
    }
  }
  // Если пришло подтверждение хранения ссылки на файл
  else if (messageData['Type'] === messageHandler.MSG_RESPONSE_FILE_LINK_HOLDING_CODE) {
    console.log('-------------------------------------------------------------');
    console.log('Validate of saving file link');
    console.log('Sender ID: ' + messageData['SenderID']);
    console.log('File ID: ' + messageData['FileID']);
    console.log('-------------------------------------------------------------');

    // Сохраняем информацию о записанном файле
    // Удаляем файл, ссылку которого сохранили, из структуры
    for (let [key, value] of filesToSend) {
      if (value[0] === messageData['FileID']) {
        dataManager.writeFileInfo(key, value);
        filesToSend.delete(key);
        break;
      }
    }
  }
  // Если пришёл запрос на получение информации о файле
  else if (messageData['Type'] === messageHandler.MSG_REQUEST_FILE_INFO_CODE) {
    if (messageData['SenderID'] === currentUserID) {
      return;
    }
    console.log('-------------------------------------------------------------');
    console.log('Request for information about file');
    console.log('Sender ID: ' + messageData['SenderID']);
    console.log('Info: ' + messageData['InfoHash']);
    console.log('-------------------------------------------------------------');

    let searchResult = dataManager.searchFile(messageData['InfoHash']);
    if (searchResult !== undefined) {
      console.log('File was found in storage');
      console.log('File ID: ' + searchResult);
      console.log('-------------------------------------------------------------');
    }
    else {
      searchResult = dataManager.searchLink(messageData['InfoHash']);
      if (searchResult !== undefined) {
        console.log('File link was found in storage');
        console.log('Handler ID: ' + searchResult);
        console.log('-------------------------------------------------------------');
      }
      else {
        console.log('Information wasn\'t found in storage');
        console.log('-------------------------------------------------------------');
      }
    }
  }
});

// Когда сокет создан
dgramSocket.bind(PORT, function () {
  console.log('Socket bound');

  dgramSocket.setBroadcast(true);

  // Проверяем новые файлы
  filesToSend = dataManager.refreshFileStorageData();

  // Считываем данные о текущем пользователе
  let userInfo = dataManager.readUserInfo();

  // Считываем информацию, которую необходимо запросить
  searchInfo = dataManager.readSearchInfo();

  // Если данные ещё не записаны
  if (userInfo === undefined) {

    // Расчитываем ID пользователя
    currentUserID = hashManager.getUserHash();

    // Запрашиваем ввод имени
      rl.question('Enter your name: ', (name) => {
        // После того, как ввели имя
        currentUserName = name;
        rl.close();

        // Записываем данные о пользователе в файл
        dataManager.writeUserInfo(currentUserID, currentUserName);

        // Вызываем функцию для проверки онлайна
        checkOnline();
        // Первый раз запускаем главную функцию чере CONNECTION_TIME мс
        setTimeout(loopFunction, CONNECTION_TIME);

        console.log('Connecting...');

      });
  }
  // Если данные о пользователе считаны из файла
  else {

    currentUserID = userInfo['ID'];
    currentUserName = userInfo['Name'];

    // Вызываем функцию для проверки онлайна
    checkOnline();
    // Первый раз запускаем главную функцию чере CONNECTION_TIME мс
    setTimeout(loopFunction, CONNECTION_TIME);

    console.log('Connecting...');
  }
});

function sendFileInfoRequest(infoHash) {
  console.log("iiii");
  let requestMessage = messageHandler.buildRequestFileInfo(currentUserID, infoHash);
  dgramSocket.send(requestMessage, 0, requestMessage.length, PORT, BROADCAST_ADDRESS);
}

// Функция, которая выполняется каждые CHECK_INTERVAL мс
function loopFunction() {

  prevOnlineUsers.users = [];

  console.log("Current Online:");
  while (currentOnlineUsers.users.length) {
    console.log(currentOnlineUsers.users[currentOnlineUsers.users.length - 1]);
    // Попутно очищаем массив для дальнейшего заполнения новой информацией
    prevOnlineUsers.users.push(currentOnlineUsers.users.pop());
  }

  // Если нужно передать ссылку на новые файлы
  if (filesToSend !== undefined) {

    for (let [key, value] of filesToSend) {
      // Расстояние между хешами
      let distance;
      // Минимальное расстояние между хешами
      let minDistance = hashManager.strToNumber('ffffffffffffffffffffffffffffffff');
      // Индекс элемента с минимальным расстоянием
      let minIndex = -1;

      for (let i = 0; i < prevOnlineUsers.users.length; i++) {
        // Не учитываем самого себя
        if (prevOnlineUsers.users[i]['ID'] === currentUserID) {
          continue;
        }

        distance = hashManager.getDistance(value[0], prevOnlineUsers.users[i]['ID']);

        // Сравнение буферов с хешами
        let compareRes = Buffer.compare(minDistance, distance);

        // Если минимальное расстояние больше текущего
        if (compareRes === 1) {
          minDistance = distance;
          minIndex = i;
        }
      }
      // Если был хоть один другой активный пользователь
      if (minIndex !== -1) {
        // Формируем сообщение для запроса на хранение ссылки на файл
        let requestMessage = messageHandler.buildSaveFileLinkRequest(currentUserID, value,
          prevOnlineUsers.users[minIndex]['ID']);

        dgramSocket.send(requestMessage, 0, requestMessage.length, PORT, BROADCAST_ADDRESS);
      }
    }
  }

  if (searchInfo !== undefined) {
    let searchHash;

    if (searchInfo['InfoType'] === 'Hash') {
      searchHash = searchInfo['FileHash'];
    }
    else if (searchInfo['InfoType'] === 'Name') {
      searchHash = hashManager.getFileNameHash(searchInfo['FileName']);
    }
    else if (searchInfo['InfoType'] === 'Content') {
      searchHash = hashManager.getFileHash(searchInfo['FileName']);
    }
    else {
      return;
    }

    let requestMessage = messageHandler.buildRequestFileInfo(currentUserID, searchHash);
    dgramSocket.send(requestMessage, 0, requestMessage.length, PORT, BROADCAST_ADDRESS);
  }

  // // Выводим информацию об online пользователях, которую сформировали с предыдущей рассылки
  // console.log("Current Online:");
  // // while (prevOnlineUsers.users.length) {
  // //   // Попутно очищаем массив для дальнейшего заполнения новой информацией
  // //   console.log(prevOnlineUsers.users.pop());
  // // }
  //
  // prevOnlineUsers.users.forEach(function (user) {
  //   console.log(user);
  // });

  // Проверяем online, отсылая всем запросы
  checkOnline();

  // Если функция вызывается первый раз, то задаём периодичность вызова
  if (isConnected === false) {
    isConnected = true;
    setInterval(loopFunction, CHECK_INTERVAL);
  }
}

// Функция, в которой выполняется широковещательная рассылка
function checkOnline() {
  let requestMessage = messageHandler.buildRequestIsOnline(currentUserID, currentUserName);

  // Отсылаем запрос
  dgramSocket.send(requestMessage, 0, requestMessage.length, PORT, BROADCAST_ADDRESS);
}
